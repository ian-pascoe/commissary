// Authentication of one request: Access JWT -> principal -> the org the request is for and the caller's role in it.
// New in the Workers port.
import { Effect, Result } from "effect";
import {
  ConfigurationError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  UnauthorizedError,
} from "../errors.ts";
import { WorkerEnv } from "../platform/env.ts";
import { admitPrincipal } from "../members/admission.ts";
import { roleAtLeast } from "../members/roles.ts";
import { CurrentOrg, type OrgId, type OrgSlug } from "../platform/org.ts";
import { platform } from "../platform/registry.ts";
import { deprecatedAdminVariables, devBypass, isAdmin, loadAccessConfig } from "./config.ts";
import type { AccessIdentity, Principal } from "./principal.ts";
import { makeIdentity } from "./principal.ts";
import type { AccessJwks } from "./jwks.ts";
import { routeAccess, type RouteAccess } from "./policy.ts";
import { type AccessZone, scopedUrl } from "./routes.ts";
import { verifyAccessJwt } from "./verify.ts";

export const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";

export type AccessError =
  | UnauthorizedError
  | ForbiddenError
  | NotFoundError
  | InternalError
  | ConfigurationError;

let devBypassRefusalLogged = false;

let deprecatedAdminLogged = false;

/** Logs (once per isolate) that `ACCESS_DEV_BYPASS` is set on a Worker that has Access configured. */
const warnDevBypassRefused = Effect.suspend(() => {
  if (devBypassRefusalLogged) return Effect.void;
  devBypassRefusalLogged = true;

  return Effect.logWarning(
    "ACCESS_DEV_BYPASS is ignored because ACCESS_TEAM_DOMAIN/ACCESS_AUD are set; remove it from this environment",
  );
});

/**
 * Logs (once per isolate) that the deployment still sets `ACCESS_ADMIN_*`, the deprecated names of the platform admin
 * variables. They keep working as aliases.
 */
export const warnDeprecatedAdminVariables = (env: Parameters<typeof deprecatedAdminVariables>[0]) =>
  Effect.suspend(() => {
    const deprecated = deprecatedAdminVariables(env);

    if (deprecatedAdminLogged || deprecated.length === 0) return Effect.void;
    deprecatedAdminLogged = true;

    return Effect.logWarning(
      `deprecated variables set: ${deprecated.join(", ")}; rename them, the old names are only read as aliases`,
    );
  });

/** Forgets what was logged, for tests that check the warnings. */
export const resetAccessWarnings = (): void => {
  devBypassRefusalLogged = false;
  deprecatedAdminLogged = false;
};

/**
 * The org a management request is for: the org addressed by the URL (`slug`, looked up in the Platform registry), the
 * request's `CurrentOrg` otherwise. An unknown slug is a 404 for a platform admin (who may create it), and a 403 like
 * any org one may not manage for everybody else, so the registry's slugs cannot be probed.
 */
const targetOrg = (slug: OrgSlug | undefined, platformAdmin: boolean) =>
  Effect.gen(function* () {
    if (slug === undefined) return yield* CurrentOrg;

    const found = yield* platform("getOrgBySlug", (stub) => stub.getOrgBySlug(slug)).pipe(
      Effect.catchTag("PlatformUnavailable", (error) =>
        Effect.fail(new InternalError({ message: error.message })),
      ),
    );

    if (found !== undefined) return found.id;

    return yield* platformAdmin
      ? new NotFoundError({ message: "Org not found" })
      : new ForbiddenError({ message: "Forbidden" });
  });

/**
 * The caller's place in `org`: a platform admin is an owner of every org (and keeps a member id where they are a
 * member, without joining); anyone else needs the role the route asks for (`policy.ts`), a platform-level route none.
 * The org's ControlPlane is asked on every request, so a removed member loses access at once.
 */
const admitted = (principal: Principal, org: OrgId, platformAdmin: boolean, needs: RouteAccess) =>
  Effect.gen(function* () {
    const admission = yield* Effect.result(admitPrincipal(org, principal, !platformAdmin));

    if (Result.isFailure(admission)) {
      yield* Effect.logWarning(`membership unavailable: ${admission.failure.message}`);

      if (!platformAdmin && needs !== "platform")
        return yield* new InternalError({ message: admission.failure.message });

      return yield* makeIdentity(principal, org, platformAdmin);
    }

    const membership = admission.success;

    if (!platformAdmin && needs !== "platform" && !roleAtLeast(membership?.role, needs))
      return yield* new ForbiddenError({ message: "Forbidden" });

    return yield* makeIdentity(principal, org, platformAdmin, membership);
  });

/**
 * Authenticates a request for the given zone.
 *
 * `headers` must expose lowercased header names; `requestUrl` is the full URL as the client sent it (the dev bypass reads
 * its host; a management URL may address an org, `/v8/management/orgs/<slug>/...`, see `routes.ts`). `method` decides,
 * with the path, the role the request needs (`policy.ts`). Failures use the Go auth middleware wording (`Missing API
 * key`, `Invalid API key`).
 *
 * The identity carries the org of the request (the addressed org, the `CurrentOrg` otherwise) and the caller's role in
 * it. A platform admin is an owner of every org; anyone else needs a role in the org (`403` otherwise), except on a
 * platform-level route.
 */
export const authenticateRequest = (
  headers: Readonly<Record<string, string | undefined>>,
  requestUrl: string,
  zone: Exclude<AccessZone, "public">,
  method = "GET",
): Effect.Effect<AccessIdentity, AccessError, WorkerEnv | CurrentOrg | AccessJwks> =>
  Effect.gen(function* () {
    const env = yield* WorkerEnv;
    const slug = zone === "management" ? scopedUrl(requestUrl)?.slug : undefined;
    const bypass = devBypass(env, requestUrl);

    if (bypass?._tag === "Active") {
      // Local `alchemy dev` only; the bypass principal is an administrator of everything.
      const org = yield* targetOrg(slug, true);

      return yield* makeIdentity(
        { kind: "user", email: bypass.email, sub: "dev-bypass" },
        org,
        true,
      );
    }

    if (bypass?._tag === "Refused") yield* warnDevBypassRefused;
    yield* warnDeprecatedAdminVariables(env);

    const config = yield* loadAccessConfig(env);
    const token = headers[ACCESS_JWT_HEADER]?.trim() ?? "";

    if (token === "") return yield* new UnauthorizedError({ message: "Missing API key" });

    const principal: Principal = yield* verifyAccessJwt(token, config);
    const platformAdmin = isAdmin(config, principal);
    const org = zone === "management" ? yield* targetOrg(slug, platformAdmin) : yield* CurrentOrg;

    return yield* admitted(principal, org, platformAdmin, routeAccess(method, requestUrl, zone));
  });
