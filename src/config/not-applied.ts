/**
 * Config keys that the Workers schema accepts (so Go documents import unchanged) but that have no effect on Workers.
 * New in the Workers port; the list is documented in docs/MIGRATION.md ("Not applied on Workers"), a warning naming
 * the keys that are set is logged when a config document is stored, and the Settings page lists them with their
 * `reason` (never their values: proxy URLs and client keys may be secret).
 */
import type { ApiKeyEntry, Config } from "./schema.ts";

export interface NotAppliedRule {
  readonly key: string;
  /** Why the key does nothing on Workers (MIGRATION.md "Why"), one line. */
  readonly reason: string;
  /**
   * The key's mapping path when one exists (`PATCH /settings` may remove it with `null`); absent for keys inside
   * lists (they are edited where the list lives, e.g. the API keys page).
   */
  readonly path?: ReadonlyArray<string>;
  readonly isSet: (config: Config) => boolean;
}

const claudeKeys = (config: Config): ReadonlyArray<ApiKeyEntry> =>
  config["api-keys"].claude.flatMap((group) => group.keys);

export const NOT_APPLIED_RULES: ReadonlyArray<NotAppliedRule> = [
  {
    key: "access.api-keys",
    reason: "Clients authenticate with Cloudflare Access; client API keys are not enforced.",
    path: ["access", "api-keys"],
    isSet: (config) => config.access["api-keys"].length > 0,
  },
  {
    key: "access.admin-emails",
    reason:
      "Org members and roles replace the config admin lists; add people on the Members page (docs/ACCESS.md).",
    path: ["access", "admin-emails"],
    isSet: (config) => config.access["admin-emails"].length > 0,
  },
  {
    key: "access.admin-service-tokens",
    reason:
      "Org members and roles replace the config admin lists; register service tokens on the Members page.",
    path: ["access", "admin-service-tokens"],
    isSet: (config) => config.access["admin-service-tokens"].length > 0,
  },
  {
    key: "models.codex-catalog",
    reason: "The Codex client catalog is bundled with the Worker; it is not fetched.",
    path: ["models", "codex-catalog"],
    isSet: (config) => config.models["codex-catalog"].trim() !== "",
  },
  {
    key: "models.devin-catalog",
    reason: "Devin models are part of the bundled catalog additions; they are not fetched.",
    path: ["models", "devin-catalog"],
    isSet: (config) => config.models["devin-catalog"].trim() !== "",
  },
  {
    key: "requests.proxy-url",
    reason: "Workers fetch cannot use outbound proxies.",
    path: ["requests", "proxy-url"],
    isSet: (config) => config.requests["proxy-url"].trim() !== "",
  },
  {
    key: "api-keys.claude[].keys[].experimental-cch-signing",
    reason: "Kept for compatibility (also in Go); signing follows the credential type.",
    isSet: (config) =>
      claudeKeys(config).some((key) => key["experimental-cch-signing"] !== undefined),
  },
  {
    key: "routing.cooldown.save-cooldown-status",
    reason:
      "Cooldowns are always kept in the control plane: it is evicted when idle, which is not a restart.",
    path: ["routing", "cooldown", "save-cooldown-status"],
    isSet: (config) => config.routing.cooldown["save-cooldown-status"],
  },
  {
    key: "observability.logs.debug",
    reason: "No debug log files; Workers Logs carry one structured line per request.",
    path: ["observability", "logs", "debug"],
    isSet: (config) => config.observability.logs.debug,
  },
  {
    key: "observability.logs.request-log",
    reason: "No request log files; Workers Logs carry one structured line per request.",
    path: ["observability", "logs", "request-log"],
    isSet: (config) => config.observability.logs["request-log"],
  },
  {
    key: "observability.usage.usage-statistics-enabled",
    reason: "Usage persistence is always on when the USAGE D1 binding exists.",
    path: ["observability", "usage", "usage-statistics-enabled"],
    isSet: (config) => config.observability.usage["usage-statistics-enabled"],
  },
  {
    key: "observability.usage.redis-usage-queue-retention-seconds",
    reason: "The usage queue lives in D1; retention is USAGE_RETENTION_DAYS.",
    path: ["observability", "usage", "redis-usage-queue-retention-seconds"],
    isSet: (config) => config.observability.usage["redis-usage-queue-retention-seconds"] !== 60,
  },
];

/** The rules `config` sets to a non-default value, in a stable order. */
export const notAppliedRules = (config: Config): ReadonlyArray<NotAppliedRule> =>
  NOT_APPLIED_RULES.filter((rule) => rule.isSet(config));

/** Keys of {@link NOT_APPLIED_RULES} that `config` sets to a non-default value, in a stable order. */
export const notAppliedSettings = (config: Config): ReadonlyArray<string> =>
  notAppliedRules(config).map((rule) => rule.key);
