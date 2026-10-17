/**
 * The per-credential quota report (`QuotaReport` of the management contract): which providers can be checked, the
 * result of one check, and how it is merged into the stored report.
 *
 * Semantics (contract, @commissary/contract/credentials): `checked_at` is the last attempt and `refreshed_at`
 * the last success; `windows` and `plan` come from the last success and survive a later failure; `error` is the last
 * attempt's failure and is absent after a success. A success without a plan (Claude's profile call failed, a provider
 * without plans) keeps the previously known plan.
 *
 * Workers deviation: Go has no server-side usage probing (the upstream panel calls the provider usage endpoints from
 * the browser through Go's `POST /requests/api-call`, not ported); see docs/ARCHITECTURE.md "Quota check".
 */
import type { JsonObject } from "@commissary/json";
import type { QuotaReport, QuotaWindow, ResetGrantStatus } from "@commissary/contract/credentials";

/** Executor keys (`executorKey`) with a usage endpoint. */
export const QUOTA_PROVIDERS = [
  "claude",
  "codex",
  "antigravity",
  "kimi",
  "kimi-ai",
  "xai",
  "meta",
  "devin",
  "opencode-go",
] as const;

export type QuotaProvider = (typeof QUOTA_PROVIDERS)[number];

const SUPPORTED: ReadonlySet<string> = new Set(QUOTA_PROVIDERS);

export const isQuotaProvider = (provider: string): provider is QuotaProvider =>
  SUPPORTED.has(provider);

/**
 * Executor keys whose provider keys (`api-keys.<family>`) can be checked with the key itself: they are listed on the
 * Accounts page as config-sourced accounts and swept by the `quota-check` cron task. Other config keys (Codex, Claude,
 * OpenCode Zen, …) have no usage endpoint that takes a provider key and stay off the list. A later kind is one entry here
 * (plus its target and probe).
 */
export const CONFIG_QUOTA_PROVIDERS = [
  "opencode-go",
] as const satisfies ReadonlyArray<QuotaProvider>;

const CONFIG_SUPPORTED: ReadonlySet<string> = new Set(CONFIG_QUOTA_PROVIDERS);

export const isConfigQuotaProvider = (provider: string): provider is QuotaProvider =>
  CONFIG_SUPPORTED.has(provider);

/**
 * The result of one check: the windows (and plan) the provider reported, or why the check failed (no secrets).
 * `resetGrants`: Claude's reset grant status, when its tolerated read answered (stored apart from the report,
 * src/quota/reset-grant-store.ts).
 */
export type QuotaOutcome =
  | {
      readonly ok: true;
      readonly plan?: string;
      readonly windows: ReadonlyArray<QuotaWindow>;
      readonly resetGrants?: ResetGrantStatus;
    }
  /** `status`: the upstream HTTP status when there was one (not stored in the report). */
  | { readonly ok: false; readonly error: string; readonly status?: number };

/** Applies one check made at `checkedAt` (ISO) to the stored report. */
export const mergeQuotaReport = (
  previous: QuotaReport | undefined,
  outcome: QuotaOutcome,
  checkedAt: string,
): QuotaReport => {
  if (outcome.ok) {
    const plan = outcome.plan ?? previous?.plan;

    return {
      checked_at: checkedAt,
      refreshed_at: checkedAt,
      ...(plan === undefined ? {} : { plan }),
      windows: [...outcome.windows],
    };
  }

  return {
    checked_at: checkedAt,
    ...(previous?.refreshed_at === undefined ? {} : { refreshed_at: previous.refreshed_at }),
    ...(previous?.plan === undefined ? {} : { plan: previous.plan }),
    windows: [...(previous?.windows ?? [])],
    error: outcome.error,
  };
};

const windowJson = (window: QuotaWindow): JsonObject => ({
  id: window.id,
  label: window.label,
  used_percent: window.used_percent,
  ...(window.resets_at === undefined ? {} : { resets_at: window.resets_at }),
  ...(window.window_seconds === undefined ? {} : { window_seconds: window.window_seconds }),
});

/** The report as a plain JSON object (credential list entries are `JsonObject`s). */
export const quotaReportJson = (report: QuotaReport): JsonObject => ({
  checked_at: report.checked_at,
  ...(report.refreshed_at === undefined ? {} : { refreshed_at: report.refreshed_at }),
  ...(report.plan === undefined ? {} : { plan: report.plan }),
  windows: report.windows.map(windowJson),
  ...(report.error === undefined ? {} : { error: report.error }),
});
