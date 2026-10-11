/**
 * The `/v8/management/credentials` routes the panel uses (`../credentials-routes.ts`; `../credential-entry.ts` builds
 * each entry), the batch actions (`../credentials-batch.ts`) and the quota checks (`../quota-routes.ts`). Shared with
 * the browser: imports `effect` only. Field names are the wire's (snake_case, like Go's auth-file list).
 *
 * Mutations answer with a status only (except refresh, the batch actions and the quota checks, which answer per
 * account): the panel re-reads the list afterwards.
 * There is no write versioning on credentials; `PATCH /credentials/fields` changes only the keys it names, so two
 * edits of different fields cannot overwrite each other.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { managementErrors } from "./errors.ts";

const optional = Schema.optionalKey;

export const CredentialStatus = Schema.Literals([
  "unknown",
  "active",
  "pending",
  "refreshing",
  "error",
  "disabled",
]);

export type CredentialStatus = typeof CredentialStatus.Type;

/** One ten-minute bucket of the recent-requests ring, labelled `HH:MM-HH:MM` (UTC). */
export const RecentRequests = Schema.Struct({
  time: Schema.String,
  success: Schema.Number,
  failed: Schema.Number,
});

/** Last observed upstream quota headers (`signals`: canonical header name to value). */
export const QuotaObservation = Schema.Struct({
  observed_at: optional(Schema.String),
  signals: Schema.Record(Schema.String, Schema.String),
});

export type QuotaObservation = typeof QuotaObservation.Type;

/**
 * One allowance window from a provider's usage endpoint: `id` is stable per provider ("five_hour", "seven_day",
 * "seven_day_opus", "primary", "secondary", "daily", "weekly", "monthly", or a model bucket id), `label` is the
 * operator-facing name ("5-hour", "Weekly", "Weekly Opus"), `used_percent` is 0–100.
 */
export const QuotaWindow = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  used_percent: Schema.Number,
  resets_at: optional(Schema.String),
  window_seconds: optional(Schema.Number),
});

export type QuotaWindow = typeof QuotaWindow.Type;

/**
 * The server-side quota check of one credential (`POST /credentials/quota`, and the scheduled sweep): `checked_at` is
 * the last attempt, `refreshed_at` the last success; `windows` and `plan` come from the last success; `error` is the
 * last attempt's failure (absent when it succeeded).
 */
export const QuotaReport = Schema.Struct({
  checked_at: Schema.String,
  refreshed_at: optional(Schema.String),
  plan: optional(Schema.String),
  windows: Schema.Array(QuotaWindow),
  error: optional(Schema.String),
});

export type QuotaReport = typeof QuotaReport.Type;

/** An unexpired retry timer of the credential or one of its models. */
export const Cooldown = Schema.Struct({
  scope: Schema.Literals(["credential", "model"]),
  model_key: optional(Schema.String),
  reason: Schema.String,
  retry_at: Schema.String,
  remaining_seconds: Schema.Number,
  backoff_level: optional(Schema.Number),
  http_status: optional(Schema.Number),
});

export type Cooldown = typeof Cooldown.Type;

/** Claims of a Codex credential's id token (no secrets). */
export const IdTokenClaims = Schema.Struct({
  chatgpt_account_id: optional(Schema.String),
  plan_type: optional(Schema.String),
  chatgpt_subscription_active_start: optional(Schema.String),
  chatgpt_subscription_active_until: optional(Schema.String),
});

/** One of the account's own model aliases (`model_aliases` in its file; the config's alias wire keys). */
export const CredentialModelAlias = Schema.Struct({
  /** Upstream model name. */
  name: Schema.String,
  /** The id clients call instead. */
  alias: Schema.String,
  /** Keep the original id next to the alias. */
  fork: optional(Schema.Boolean),
  "force-mapping": optional(Schema.Boolean),
  "display-name": optional(Schema.String),
});

export type CredentialModelAlias = typeof CredentialModelAlias.Type;

export const CredentialEntry = Schema.Struct({
  id: Schema.String,
  auth_index: Schema.String,
  name: Schema.String,
  type: Schema.String,
  provider: Schema.String,
  label: Schema.String,
  status: CredentialStatus,
  status_message: Schema.String,
  disabled: Schema.Boolean,
  unavailable: Schema.Boolean,
  runtime_only: Schema.Boolean,
  source: Schema.String,
  size: Schema.Number,
  success: Schema.Number,
  failed: Schema.Number,
  recent_requests: Schema.Array(RecentRequests),
  quota: QuotaObservation,
  model_quotas: optional(Schema.Record(Schema.String, QuotaObservation)),
  quota_report: optional(QuotaReport),
  supports_quota: optional(Schema.Boolean),
  email: optional(Schema.String),
  account: optional(Schema.String),
  account_type: optional(Schema.String),
  project_id: optional(Schema.String),
  id_token: optional(IdTokenClaims),
  created_at: optional(Schema.String),
  updated_at: optional(Schema.String),
  last_refresh: optional(Schema.String),
  next_retry_after: optional(Schema.String),
  priority: optional(Schema.Number),
  note: optional(Schema.String),
  weight: optional(Schema.Number),
  request_retry: optional(Schema.Number),
  websockets: optional(Schema.Boolean),
  /** Model prefix: clients reach this account alone as `<prefix>/<model>`. */
  prefix: optional(Schema.String),
  /** The account's own cooling switch; absent when the routing setting applies. */
  disable_cooling: optional(Schema.Boolean),
  /**
   * Extra upstream request headers. Values whose names look secret are masked (`[redacted]…abcd`, `REDACTED_PREFIX`
   * in `api-keys.ts`); sending the mask back for the same header keeps the stored value.
   */
  headers: optional(Schema.Record(Schema.String, Schema.String)),
  /** The account's own exclusions (lower-case names or `*` patterns), without the channel rules. */
  excluded_models: optional(Schema.Array(Schema.String)),
  /** The account's own aliases, before the channel rules. */
  model_aliases: optional(Schema.Array(CredentialModelAlias)),
  cooldowns: Schema.Array(Cooldown),
});

export type CredentialEntry = typeof CredentialEntry.Type;

export const CredentialList = Schema.Struct({
  observed_at: optional(Schema.String),
  files: Schema.Array(CredentialEntry),
});

const Ok = Schema.Struct({ status: Schema.Literal("ok") });

/**
 * The editable fields the panel sends; `null` clears a field (the routing default applies again). `headers` merges
 * into the stored ones: an empty value removes a header, the masked value of a header keeps it. A refused value
 * answers `422` with the field's name in `path`.
 */
export const CredentialFieldsPatch = Schema.Struct({
  name: Schema.String,
  priority: optional(Schema.NullOr(Schema.Int)),
  note: optional(Schema.NullOr(Schema.String)),
  weight: optional(Schema.NullOr(Schema.Int)),
  request_retry: optional(Schema.NullOr(Schema.Int)),
  prefix: optional(Schema.NullOr(Schema.String)),
  disable_cooling: optional(Schema.NullOr(Schema.Boolean)),
  websockets: optional(Schema.NullOr(Schema.Boolean)),
  headers: optional(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
  excluded_models: optional(Schema.NullOr(Schema.Array(Schema.String))),
  model_aliases: optional(Schema.NullOr(Schema.Array(CredentialModelAlias))),
});

export type CredentialFieldsPatch = typeof CredentialFieldsPatch.Type;

/**
 * What a batch applies to every account it names (`POST /credentials/batch`). A `delete` of a name that is not stored
 * (already deleted, or never there) answers `ok: true`, like a delete that just happened: what was asked for holds.
 * Only a config API key, which cannot be deleted here, answers `not_found`.
 */
export const BatchAction = Schema.Literals(["enable", "disable", "refresh", "delete"]);

export type BatchAction = typeof BatchAction.Type;

/** Most accounts one batch request may name; the panel sends larger selections in several requests. */
export const MAX_BATCH_NAMES = 100;

/**
 * Most accounts one `refresh` batch may name: each is an upstream token call the ControlPlane makes (four at a time),
 * so a refresh request is kept short. The panel splits a larger selection by it.
 */
export const MAX_BATCH_REFRESH_NAMES = 20;

/** The most names a batch of `action` may carry. */
export const batchLimit = (action: BatchAction): number =>
  action === "refresh" ? MAX_BATCH_REFRESH_NAMES : MAX_BATCH_NAMES;

/**
 * One account's outcome in a batch or a check of every quota. `error` is a code (`not_found`, `refresh_failed`,
 * `unauthorized`, `check_failed`, `stale`, `unavailable`, `not_refreshable`), `message` a fixed reason and `status` the
 * upstream HTTP status when there was one; none of them ever carries a token or an upstream body. `skipped` (with `ok:
 * false`, `error: "not_refreshable"`): the action did not apply to the account (a refresh of an account without a
 * refresh token); it counts as neither succeeded nor failed.
 */
export const AccountResult = Schema.Struct({
  name: Schema.String,
  ok: Schema.Boolean,
  skipped: optional(Schema.Boolean),
  error: optional(Schema.String),
  message: optional(Schema.String),
  status: optional(Schema.Number),
});

export type AccountResult = typeof AccountResult.Type;

export const BatchResult = Schema.Struct({
  action: BatchAction,
  /** One per distinct name, in the order sent. */
  results: Schema.Array(AccountResult),
  succeeded: Schema.Number,
  failed: Schema.Number,
  skipped: Schema.Number,
});

export type BatchResult = typeof BatchResult.Type;

export const QuotaSweepResult = Schema.Struct({
  started_at: Schema.String,
  finished_at: Schema.String,
  /** One per enabled account whose provider reports quota; a failed check keeps the account's last figures. */
  results: Schema.Array(AccountResult),
  checked: Schema.Number,
  failed: Schema.Number,
});

export type QuotaSweepResult = typeof QuotaSweepResult.Type;

export const CredentialModel = Schema.Struct({
  id: Schema.String,
  display_name: optional(Schema.String),
  type: optional(Schema.String),
  owned_by: optional(Schema.String),
});

export class CredentialsGroup extends HttpApiGroup.make("credentials").add(
  HttpApiEndpoint.get("list", "/credentials", {
    success: CredentialList,
    error: managementErrors,
  }),
  /**
   * Enable or disable one credential. A config API key (`name` is its credential id, `KeyRuntime.id`) is disabled by
   * adding `*` to its `excluded-models` (`via`, as Go answers); its `auth_index` stays the same. OpenAI-compatible
   * keys answer 409: disable the endpoint (the group's `disabled`) instead.
   */
  HttpApiEndpoint.patch("setDisabled", "/credentials/status", {
    payload: Schema.Struct({
      name: Schema.String,
      auth_index: optional(Schema.String),
      disabled: Schema.Boolean,
    }),
    success: Schema.Struct({
      status: Schema.Literal("ok"),
      disabled: Schema.Boolean,
      via: optional(Schema.Literal("config:excluded-models")),
      excluded_pattern: optional(Schema.String),
    }),
    error: managementErrors,
  }),
  HttpApiEndpoint.patch("patchFields", "/credentials/fields", {
    payload: CredentialFieldsPatch,
    success: Ok,
    error: managementErrors,
  }),
  /** Refresh one credential's tokens now; answers the fresh entry. */
  HttpApiEndpoint.post("refresh", "/credentials/refresh", {
    payload: Schema.Struct({ name: Schema.String }),
    success: Schema.Struct({ ok: Schema.Literal(true), auth: CredentialEntry }),
    error: managementErrors,
  }),
  /** Clear the credential's and its models' retry timers. */
  HttpApiEndpoint.post("resetCooldown", "/routing/cooldown/reset", {
    payload: Schema.Struct({ auth_index: Schema.String }),
    success: Schema.Struct({
      status: Schema.Literal("ok"),
      auth_index: Schema.String,
      models: Schema.Array(Schema.String),
    }),
    error: managementErrors,
  }),
  HttpApiEndpoint.delete("remove", "/credentials", {
    query: { name: Schema.String },
    success: Ok,
    error: managementErrors,
  }),
  /** Add or replace one auth file (`name` ends in `.json`; the body is the file's JSON text). */
  HttpApiEndpoint.post("upload", "/credentials", {
    query: { name: Schema.String },
    payload: Schema.String.pipe(HttpApiSchema.asText({ contentType: "application/json" })),
    success: Ok,
    error: managementErrors,
  }),
  /** The models this credential can serve. */
  HttpApiEndpoint.get("models", "/credentials/models", {
    query: { name: Schema.String },
    success: Schema.Struct({ models: Schema.Array(CredentialModel) }),
    error: managementErrors,
  }),
  /** Ask the provider's usage endpoint for this credential's allowance now (server side; no tokens leave). */
  HttpApiEndpoint.post("checkQuota", "/credentials/quota", {
    payload: Schema.Struct({ name: Schema.String }),
    success: Schema.Struct({ status: Schema.Literal("ok"), report: QuotaReport }),
    error: managementErrors,
  }),
  /**
   * Enable, disable, refresh the tokens of or delete several accounts (auth files) at once; answers each account's
   * outcome, so some may succeed while others fail. At most {@link MAX_BATCH_NAMES} names, {@link
   * MAX_BATCH_REFRESH_NAMES} for `refresh` (`400` beyond).
   */
  HttpApiEndpoint.post("batch", "/credentials/batch", {
    payload: Schema.Struct({ action: BatchAction, names: Schema.Array(Schema.String) }),
    success: BatchResult,
    error: managementErrors,
  }),
  /**
   * Check the quota of every enabled account that reports it, a few at a time, and answer each outcome. `409
   * quota_check_running` while another check of every account (the scheduled one included) is under way.
   */
  HttpApiEndpoint.post("checkAllQuotas", "/credentials/quota/all", {
    success: QuotaSweepResult,
    error: managementErrors,
  }),
) {}
