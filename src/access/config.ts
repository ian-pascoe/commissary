// Configuration of Cloudflare Access verification, read from the Worker env (vars/secrets).
// New in the Workers port (Go used `access.api-keys`); see docs/ARCHITECTURE.md "Authentication".
import { Data, Effect } from "effect";
import { ConfigurationError } from "../errors.ts";
import type { Config } from "../config/schema.ts";
import type { Principal } from "./principal.ts";

export interface AccessConfig {
  /** Issuer expected in `iss`, e.g. `https://team.cloudflareaccess.com`. */
  readonly issuer: string;
  readonly jwksUrl: string;
  /** Accepted Access application AUD tags. */
  readonly audiences: ReadonlyArray<string>;
  /** Lowercased admin emails. */
  readonly adminEmails: ReadonlySet<string>;
  /** Admin service token client ids (`common_name`). */
  readonly adminServiceTokens: ReadonlySet<string>;
}

const DEFAULT_DEV_EMAIL = "dev@localhost";

const TEAM_HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

const splitList = (value: string | undefined): ReadonlyArray<string> =>
  (value ?? "")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter((item) => item !== "");

/** Accepts `team`, `team.cloudflareaccess.com` or `https://team.cloudflareaccess.com[/]`. */
const normalizeTeamHost = (raw: string): string | undefined => {
  const host = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");

  if (host === "" || !TEAM_HOST.test(host)) return undefined;

  return host.includes(".") ? host : `${host}.cloudflareaccess.com`;
};

/**
 * The variables that name the platform admins: `PLATFORM_ADMIN_EMAILS` / `PLATFORM_ADMIN_SERVICE_TOKENS`, and the
 * deprecated `ACCESS_ADMIN_EMAILS` / `ACCESS_ADMIN_SERVICE_TOKENS` they replace (ADR 0022), still read as aliases so a
 * deployment upgrades without changing its settings.
 */
export type PlatformAdminEnv = Partial<
  Pick<
    Env,
    | "PLATFORM_ADMIN_EMAILS"
    | "PLATFORM_ADMIN_SERVICE_TOKENS"
    | "ACCESS_ADMIN_EMAILS"
    | "ACCESS_ADMIN_SERVICE_TOKENS"
  >
>;

/**
 * The platform admins named by the deployment (emails lowercased): the union of the `PLATFORM_ADMIN_*` variables and
 * their deprecated `ACCESS_ADMIN_*` aliases. They need no stored state, so they can always repair the Platform registry
 * or any org.
 */
export const platformAdminLists = (env: PlatformAdminEnv): AdminLists => ({
  adminEmails: new Set(
    [...splitList(env.PLATFORM_ADMIN_EMAILS), ...splitList(env.ACCESS_ADMIN_EMAILS)].map((email) =>
      email.toLowerCase(),
    ),
  ),
  adminServiceTokens: new Set([
    ...splitList(env.PLATFORM_ADMIN_SERVICE_TOKENS),
    ...splitList(env.ACCESS_ADMIN_SERVICE_TOKENS),
  ]),
});

/** The deprecated variables (`ACCESS_ADMIN_*`) a deployment still sets, to be renamed to `PLATFORM_ADMIN_*`. */
export const deprecatedAdminVariables = (env: PlatformAdminEnv): ReadonlyArray<string> =>
  (
    [
      ["ACCESS_ADMIN_EMAILS", "PLATFORM_ADMIN_EMAILS", env.ACCESS_ADMIN_EMAILS],
      [
        "ACCESS_ADMIN_SERVICE_TOKENS",
        "PLATFORM_ADMIN_SERVICE_TOKENS",
        env.ACCESS_ADMIN_SERVICE_TOKENS,
      ],
    ] as const
  ).flatMap(([old, current, value]) =>
    splitList(value).length > 0 ? [`${old} (now ${current})`] : [],
  );

type AccessEnv = Pick<Env, "ACCESS_TEAM_DOMAIN" | "ACCESS_AUD"> & PlatformAdminEnv;

/** Parses and validates the Access settings. Fails closed when the team domain or AUD is missing. */
export const loadAccessConfig = (
  env: AccessEnv,
): Effect.Effect<AccessConfig, ConfigurationError> => {
  const host = normalizeTeamHost(env.ACCESS_TEAM_DOMAIN ?? "");

  if (host === undefined) {
    return Effect.fail(
      new ConfigurationError({ message: "ACCESS_TEAM_DOMAIN is missing or invalid" }),
    );
  }

  const audiences = splitList(env.ACCESS_AUD);

  if (audiences.length === 0) {
    return Effect.fail(new ConfigurationError({ message: "ACCESS_AUD is missing" }));
  }

  return Effect.succeed({
    issuer: `https://${host}`,
    jwksUrl: `https://${host}/cdn-cgi/access/certs`,
    audiences,
    ...platformAdminLists(env),
  });
};

/** Admin allow-lists (platform admins, or an org's config admins): lowercased emails and service token client ids. */
export type AdminLists = Pick<AccessConfig, "adminEmails" | "adminServiceTokens">;

export const isAdmin = (lists: AdminLists, principal: Principal) =>
  principal.kind === "user"
    ? lists.adminEmails.has(principal.email.toLowerCase())
    : lists.adminServiceTokens.has(principal.commonName);

/**
 * The `access.admin-emails` / `access.admin-service-tokens` keys of the config document. They extend the platform
 * admins for the org `global` only, until orgs have members of their own; the platform admins always apply, so one of
 * them can repair a broken config.
 */
export const configAdminLists = (config: Pick<Config, "access">): AdminLists => ({
  adminEmails: new Set(
    config.access["admin-emails"].map((email) => email.trim().toLowerCase()).filter(Boolean),
  ),
  adminServiceTokens: new Set(
    config.access["admin-service-tokens"].map((id) => id.trim()).filter(Boolean),
  ),
});

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

type DevBypassEnv = Pick<Env, "ACCESS_DEV_BYPASS"> &
  Partial<Pick<Env, "ACCESS_TEAM_DOMAIN" | "ACCESS_AUD">>;

/** Outcome of the dev bypass check: `undefined` when `ACCESS_DEV_BYPASS` is unset or the host is not loopback. */
export type DevBypass = DevBypassOutcome | undefined;

type DevBypassOutcome = Data.TaggedEnum<{
  Active: { readonly email: string };
  Refused: {};
}>;

const { Active, Refused } = Data.taggedEnum<DevBypassOutcome>();

/**
 * Whether the Worker is wired to Access (`ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` set): a deployed stage. Such a Worker
 * refuses the dev bypass and the fixed development keys (`AUTH_INDEX_KEY`, `SECRETS_KEY`).
 */
export const isDeployedStage = (env: {
  readonly ACCESS_TEAM_DOMAIN?: string | undefined;
  readonly ACCESS_AUD?: string | undefined;
}): boolean => (env.ACCESS_TEAM_DOMAIN ?? "").trim() !== "" || (env.ACCESS_AUD ?? "").trim() !== "";

/**
 * `ACCESS_DEV_BYPASS` is honoured only when the request itself targets a loopback host, which is only the case under
 * `alchemy dev`: production traffic always arrives with the Access-protected custom domain as host. It is refused
 * (`Refused`, the caller logs a warning) whenever `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` is set: a Worker that is wired
 * to Access must never skip it. The bypass principal is a user and is treated as an administrator.
 */
export const devBypass = (env: DevBypassEnv, requestUrl: string): DevBypass => {
  const value = (env.ACCESS_DEV_BYPASS ?? "").trim();

  if (value === "") return undefined;

  if (isDeployedStage(env)) return Refused();

  let hostname: string;

  try {
    hostname = new URL(requestUrl).hostname;
  } catch {
    return undefined;
  }

  if (!LOOPBACK_HOSTS.has(hostname)) return undefined;

  return Active({ email: /^(1|true|yes)$/i.test(value) ? DEFAULT_DEV_EMAIL : value });
};

/** The dev bypass email, or undefined when the bypass does not apply (see {@link devBypass}). */
export const devBypassEmail = (env: DevBypassEnv, requestUrl: string): string | undefined => {
  const bypass = devBypass(env, requestUrl);

  return bypass?._tag === "Active" ? bypass.email : undefined;
};
