// Authentication of one request: Access JWT -> principal -> (for management) admin check and the org the request is for.
// New in the Workers port.
import { Effect, Result } from "effect";
import {
  ConfigurationError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  UnauthorizedError,
} from "../errors.ts";
import type { ConfigStoreError } from "../config/errors.ts";
import { WorkerEnv } from "../platform/env.ts";
import { CurrentOrg, GLOBAL_ORG, type OrgId, type OrgSlug } from "../platform/org.ts";
import { platform } from "../platform/registry.ts";
import {
  type AdminLists,
  deprecatedAdminVariables,
  devBypass,
  isAdmin,
  loadAccessConfig,
} from "./config.ts";
import type { AccessIdentity, Principal } from "./principal.ts";
import { makeIdentity } from "./principal.ts";
import type { AccessJwks } from "./jwks.ts";
import { type AccessZone, scopedUrl } from "./routes.ts";
import { verifyAccessJwt } from "./verify.ts";

export const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";

export type AccessError =
  | UnauthorizedError
  | ForbiddenError
  | NotFoundError
  | InternalError
  | ConfigurationError;

/**
 * Additional admin allow-lists of an org (the config document's `access.admin-*`); a failure only denies, never errors.
 * They apply to the org `global` only, until orgs have members of their own.
 */
export type ExtraAdmins = Effect.Effect<AdminLists, ConfigStoreError, WorkerEnv | CurrentOrg>;

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

/** The platform admins first (no I/O); the config admins of the org `global` only for principals that are not. */
const mayManage = (
  platformAdmin: boolean,
  org: OrgId,
  principal: Principal,
  extra: ExtraAdmins | undefined,
) =>
  Effect.gen(function* () {
    if (platformAdmin) return true;

    // Until orgs have members, the config admin lists extend the platform admins for `global` only.
    if (extra === undefined || org !== GLOBAL_ORG) return false;
    const lists = yield* Effect.result(extra.pipe(Effect.provideService(CurrentOrg, org)));

    if (Result.isFailure(lists)) {
      yield* Effect.logWarning("config admin allow-list unavailable; only PLATFORM_ADMIN_* apply");

      return false;
    }

    return isAdmin(lists.success, principal);
  });

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
 * Authenticates a request for the given zone.
 *
 * `headers` must expose lowercased header names; `requestUrl` is the full URL as the client sent it (the dev bypass reads
 * its host; a management URL may address an org, `/v8/management/orgs/<slug>/...`, see `routes.ts`). `extraAdmins`
 * extends the platform admins for the management zone. Failures use the Go auth middleware wording (`Missing API key`,
 * `Invalid API key`).
 *
 * The identity carries the org of the request: the addressed org, the `CurrentOrg` otherwise. A platform admin may
 * manage every org; anyone else only `global`, and only when the config document's admin lists name them.
 */
export const authenticateRequest = (
  headers: Readonly<Record<string, string | undefined>>,
  requestUrl: string,
  zone: Exclude<AccessZone, "public">,
  extraAdmins?: ExtraAdmins,
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

    if (zone !== "management")
      return yield* makeIdentity(principal, yield* CurrentOrg, platformAdmin);

    const org = yield* targetOrg(slug, platformAdmin);

    if (!(yield* mayManage(platformAdmin, org, principal, extraAdmins))) {
      return yield* new ForbiddenError({ message: "Forbidden" });
    }

    return yield* makeIdentity(principal, org, platformAdmin);
  });
