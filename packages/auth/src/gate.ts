/**
 * What both gates (`access-gate.ts` for a self-hosted Commissary, `hosted-gate.ts` for Commissary Cloud) share: the
 * failures they answer, the org a management request is for, the caller's place in it, and the identity of an API key.
 * New in the Workers port.
 */
import { Effect, Result } from "effect";
import {
  type ConfigurationError,
  CurrentOrg,
  ForbiddenError,
  InternalError,
  NotFoundError,
  type OrgId,
  type OrgSlug,
  type RateLimitedError,
  UnauthorizedError,
} from "@commissary/core";
import { admitPrincipal } from "./admission.ts";
import { verifyApiKey } from "./api-key.ts";
import { AuthDirectory } from "./directory.ts";
import { type AdmissiblePrincipal, makeIdentity } from "./principal.ts";
import { roleAtLeast, type RouteAccess } from "./roles.ts";

export type AccessError =
  | UnauthorizedError
  | ForbiddenError
  | NotFoundError
  | InternalError
  | ConfigurationError
  | RateLimitedError;

/**
 * What the Worker's routes say about a management request: the role it needs (the role table, `management/policy.ts`)
 * and the org its URL addresses (`/v9/management/orgs/<slug>/...`, `/o/<slug>/...`; `management/zones.ts`), if any.
 */
export interface ManagementRoute {
  readonly needs: RouteAccess;
  readonly slug?: OrgSlug | undefined;
}

/**
 * The org a management request is for: the org addressed by the URL (`slug`, looked up in the Platform registry), the
 * request's `CurrentOrg` otherwise. An unknown slug is a 404 for a platform admin (who may create it), and a 403 like
 * any org one may not manage for everybody else, so the registry's slugs cannot be probed.
 */
export const targetOrg = (slug: OrgSlug | undefined, platformAdmin: boolean) =>
  Effect.gen(function* () {
    if (slug === undefined) return yield* CurrentOrg;
    const directory = yield* AuthDirectory;

    const found = yield* directory
      .getOrgBySlug(slug)
      .pipe(Effect.mapError((error) => new InternalError({ message: error.message })));

    if (found !== undefined) return found.id;

    return yield* platformAdmin
      ? new NotFoundError({ message: "Org not found" })
      : new ForbiddenError({ message: "Forbidden" });
  });

/**
 * The caller's place in `org`: a platform admin is an owner of every org (and keeps a member id where they are a
 * member, without joining); anyone else needs the role the route asks for, a platform-level route none. The org's
 * ControlPlane is asked on every request, so a removed member loses access at once. On a client API route (`client`
 * given; it needs `member`) the org must still accept Access sign-ins from clients (its `access_clients` setting);
 * otherwise the client is asked for an API key, like a request without credentials, and `Invalid API key` when it sent
 * another credential (`credentialSent`).
 */
export const admitted = (
  principal: AdmissiblePrincipal,
  org: OrgId,
  platformAdmin: boolean,
  needs: RouteAccess,
  client: { readonly credentialSent: boolean } | undefined,
) =>
  Effect.gen(function* () {
    const admission = yield* Effect.result(
      admitPrincipal(org, principal, !platformAdmin, client !== undefined),
    );

    if (Result.isFailure(admission)) {
      yield* Effect.logWarning(`membership unavailable: ${admission.failure.message}`);

      if (!platformAdmin && needs !== "platform")
        return yield* new InternalError({ message: admission.failure.message });

      return yield* makeIdentity(principal, org, platformAdmin);
    }

    const answer = admission.success;

    if (answer !== undefined && "apiKeysOnly" in answer)
      return yield* new UnauthorizedError({
        message: client?.credentialSent === true ? "Invalid API key" : "Missing API key",
      });

    if (!platformAdmin && needs !== "platform" && !roleAtLeast(answer?.role, needs))
      return yield* new ForbiddenError({ message: "Forbidden" });

    return yield* makeIdentity(principal, org, platformAdmin, answer);
  });

/** The identity of a live API key: its member, in the org the key names (ADR 0022). Never a platform admin. */
export const keyIdentity = Effect.fnUntraced(function* (text: string) {
  const key = yield* verifyApiKey(text);

  return yield* makeIdentity(
    { kind: "key", keyId: key.keyId, memberId: key.memberId, email: key.email },
    key.org,
    false,
    { role: key.role, memberId: key.memberId },
  );
});
