/**
 * The model catalog's status and its on-demand refresh (`apps/app/src/management/catalog-routes.ts`, `apps/app/src/registry/refresh.ts`): the
 * models.dev document every provider's models are built from (ADR 0020). Workers addition, no Go counterpart. Shared
 * with the browser: imports `effect` only.
 *
 * The catalog refreshes by itself every 3 hours (cron) and on demand (`POST /models/catalog/refresh`, the Models
 * page's "Refresh catalog"). Both run the same operation: download, validate, trim, store; a refresh that fails keeps
 * the stored catalog. They never run at once: while one holds the refresh lease the other is refused (`409
 * catalog_refresh_running`). The `models.catalog` setting decides the source (`mode`); `embed` (the shipped copy only)
 * and `disabled` (no refresh) do not fetch, so the on-demand refresh is refused there (`409 catalog_not_fetched`).
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { managementErrors } from "./errors.ts";

const optional = Schema.optionalKey;

/** The `models.catalog` setting as the panel names it: official source, shipped copy only, off, or a custom URL. */
export const CatalogMode = Schema.Literals(["official", "embed", "disabled", "custom"]);

export type CatalogMode = typeof CatalogMode.Type;

/** How a refresh ended: the stored catalog changed, was already current, or the attempt failed (nothing changed). */
export const RefreshStatus = Schema.Literals(["updated", "unchanged", "failed"]);

export type RefreshStatus = typeof RefreshStatus.Type;

/** Models per models.dev provider id (`anthropic`, `google`, ..., `opencode-go`). */
export const ModelCounts = Schema.Record(Schema.String, Schema.Int);

export type ModelCounts = typeof ModelCounts.Type;

export const CatalogAttempt = Schema.Struct({
  /** ISO time of the attempt. */
  at: Schema.String,
  status: RefreshStatus,
  /** Why it failed (a fixed message, never a URL or upstream body). */
  message: optional(Schema.String),
});

export type CatalogAttempt = typeof CatalogAttempt.Type;

export const CatalogStatus = Schema.Struct({
  mode: CatalogMode,
  /** Host of the custom source (`mode: "custom"`). */
  source_host: optional(Schema.String),
  /** Why the setting is unusable (`mode: "disabled"` from an address that is not http(s)). */
  source_problem: optional(Schema.String),
  /** `true` when the catalog in use is a refreshed copy from KV, `false` for the copy shipped with the Worker. */
  stored: Schema.Boolean,
  /** ISO time the stored catalog was last confirmed current (a refresh that updated it or found it unchanged). */
  refreshed_at: optional(Schema.String),
  /** The latest refresh attempt, the scheduled one or the panel's. */
  last_attempt: optional(CatalogAttempt),
  /** Models per models.dev provider in the catalog in use. */
  models: ModelCounts,
});

export type CatalogStatus = typeof CatalogStatus.Type;

export const CatalogRefresh = Schema.Struct({
  status: RefreshStatus,
  /** Why it failed. */
  message: optional(Schema.String),
  /** Models clients can call that appeared / disappeared (per provider, deduplicated across Codex plans; `updated` only). */
  added: optional(Schema.Int),
  removed: optional(Schema.Int),
  /** Model entries of the document that were malformed and left out. */
  skipped: optional(Schema.Int),
  /** The status after this refresh. */
  catalog: CatalogStatus,
});

export type CatalogRefresh = typeof CatalogRefresh.Type;

export class CatalogGroup extends HttpApiGroup.make("catalog").add(
  /** Which catalog is in use, where it comes from and when it was last refreshed. */
  HttpApiEndpoint.get("status", "/models/catalog", {
    success: CatalogStatus,
    error: managementErrors,
  }),
  /**
   * Refresh the catalog now: the cron task's operation. A failed download, size or validation problem is a `200` with
   * `status: "failed"` (the stored catalog stays); `409 catalog_refresh_running` while another refresh runs,
   * `409 catalog_not_fetched` when `models.catalog` is `embed` or `disabled`.
   */
  HttpApiEndpoint.post("refresh", "/models/catalog/refresh", {
    success: CatalogRefresh,
    error: managementErrors,
  }),
) {}
