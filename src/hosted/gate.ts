/**
 * Authentication on a hosted proxy (ADR 0026), the counterpart of `access/authenticate.ts`: no Access application sits
 * in front of the Worker, so Access JWTs and Access service tokens are accepted nowhere. New in the Workers port.
 *
 * - Proxy routes take proxy keys only. A key of a suspended org or person is refused, and each org's requests are
 *   rate-limited (`rate-limit.ts`).
 * - The management API and the panel take the session cookie of a person signed in with Better Auth (`session.ts`):
 *   the same verified email Access yields on a self-hosted proxy, so roles, the person-to-orgs index and caller scopes
 *   work unchanged. A first sign-in signs the person up (`standing.ts`). Platform admins are the people in
 *   `PLATFORM_ADMIN_EMAILS` (a verified email); `PLATFORM_ADMIN_SERVICE_TOKENS` means nothing here.
 */
import { Effect } from "effect";
import { admitted, keyIdentity, targetOrg, type AccessError } from "../access/authenticate.ts";
import { platformAdminLists } from "../access/config.ts";
import { routeAccess } from "../access/policy.ts";
import type { AccessIdentity, Principal } from "../access/principal.ts";
import { presentedCredentials } from "../access/proxy-key.ts";
import { type AccessZone, scopedUrl } from "../access/routes.ts";
import { UnauthorizedError } from "../errors.ts";
import { WorkerEnv } from "../platform/env.ts";
import type { CurrentOrg } from "../platform/org.ts";
import { limitOrgRate } from "./rate-limit.ts";
import { signedInPerson } from "./session.ts";
import { ensureSignedUp, requireStanding } from "./standing.ts";

/** The answer to a management request without a live session. */
export const NOT_SIGNED_IN = "Not signed in";

const originOf = (requestUrl: string): string => {
  try {
    return new URL(requestUrl).origin;
  } catch {
    return "";
  }
};

/** Authenticates a request of a hosted proxy for `zone`; see the module comment. */
export const authenticateHosted = (
  headers: Readonly<Record<string, string | undefined>>,
  requestUrl: string,
  zone: Exclude<AccessZone, "public">,
  method = "GET",
): Effect.Effect<AccessIdentity, AccessError, WorkerEnv | CurrentOrg> =>
  Effect.gen(function* () {
    const env = yield* WorkerEnv;

    if (zone === "protected") {
      const credentials = presentedCredentials(headers, requestUrl);

      if (credentials.proxyKey === undefined)
        return yield* new UnauthorizedError({
          message: credentials.any ? "Invalid API key" : "Missing API key",
        });
      const identity = yield* keyIdentity(credentials.proxyKey);

      yield* requireStanding(
        identity.org,
        identity.principal.kind === "key" ? identity.principal.email : undefined,
      );
      yield* limitOrgRate(identity.org);

      return identity;
    }

    const person = yield* signedInPerson(env, originOf(requestUrl), headers);

    if (person === undefined) return yield* new UnauthorizedError({ message: NOT_SIGNED_IN });
    yield* ensureSignedUp(person.email);

    const principal: Principal = {
      kind: "user",
      email: person.email,
      sub: `hosted:${person.userId}`,
    };

    const platformAdmin = platformAdminLists(env).adminEmails.has(person.email);
    const org = yield* targetOrg(scopedUrl(requestUrl)?.slug, platformAdmin);

    // A platform admin still reaches a suspended org, to look at it and unsuspend it.
    if (!platformAdmin) yield* requireStanding(org, person.email);

    return yield* admitted(
      principal,
      org,
      platformAdmin,
      routeAccess(method, requestUrl, zone),
      undefined,
    );
  });
