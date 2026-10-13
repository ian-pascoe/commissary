import { DurableObject } from "cloudflare:workers";
import { Effect, Schema } from "effect";
import { FetchHttpClient, type HttpClient } from "effect/http";
import {
  ConfigStore,
  decodeStoredConfig,
  type ConfigSnapshotWire,
  type PutConfigResult,
} from "../config/store.ts";
import type { Config } from "../config/schema.ts";
import type { JsonObject } from "../json/index.ts";
import { isTokenPayloadKey } from "./merge.ts";
import { CredentialPool, type ConfigView, type RefreshTarget, type UpsertResult } from "./pool.ts";
import { type Credential, executorKey } from "./model.ts";
import {
  RefreshManager,
  type RefreshOptions,
  type RefreshResult,
  type RunSummary,
} from "./refresh/index.ts";
import { type RetryPlan, RetryQuery } from "./selection/retry.ts";
import {
  Lease,
  PickRequest,
  ReportResult,
  type PickResult,
  type ReportOutcome,
} from "./selection/types.ts";
import { CredentialStore } from "./store.ts";
import type { CredentialSummary } from "./summary.ts";
import type { ModelSource } from "../registry/source.ts";
import { type AuthIndexer, orgAuthIndexer } from "../management/auth-index.ts";
import {
  type ApiKeyProbeTargetResult,
  buildApiKeyProbeTarget,
} from "../management/api-keys-probe.ts";
import { buildApiKeysList } from "../management/api-keys-view.ts";
import { locateKey, setKeyExcludedAll } from "../management/api-keys-write.ts";
import { configKeyIds } from "../management/config-document.ts";
import {
  buildConfigCredentialEntry,
  buildCredentialEntry,
} from "../management/credential-entry.ts";
import {
  apiCallToken,
  findCredential,
  type CredentialMutation,
  type CredentialRef,
  type RefreshAllItem,
  type RefreshOneResult,
} from "../management/credential-ops.ts";
import { applyFieldPatch } from "./field-patch.ts";
import { type DevinStatusSummary, refreshDevinStatuses } from "./devin-status.ts";
import {
  type CallbackInput,
  type CallbackResult,
  makeOAuthService,
  type OAuthService,
  type StartInput,
  type StartResult,
  type StatusResult,
} from "../oauth/service.ts";
import { OAuthSessions, SqliteSessionTable } from "../oauth/session-store.ts";
import type {
  AccountResult,
  BatchAction,
  PendingResetClaim,
  QuotaReport,
  ResetGrantStatus,
} from "../management/contract/credentials.ts";
import {
  isConfigQuotaProvider,
  isQuotaProvider,
  mergeQuotaReport,
  type QuotaOutcome,
} from "../quota/report.ts";
import { orgOfControlPlane, type OrgId } from "../platform/org.ts";
import { QuotaReportStore } from "../quota/store.ts";
import { type SweepSource, SweepLeaseStore, type TakeLease } from "../quota/sweep-lease.ts";
import {
  type PutStatusResult,
  type ResetGrantMark,
  ResetGrantStore,
} from "../quota/reset-grant-store.ts";
import {
  beginClaim,
  type BeginClaim,
  type ClaimAnswer,
  type FreshClaim,
  holdsOrganization,
  openClaim,
  pendingClaimJson,
  settleClaim,
} from "../quota/reset-grants.ts";
import { buildQuotaTarget, type QuotaTargetResult } from "../quota/target.ts";

const decodePickRequest = Schema.decodeUnknownSync(PickRequest);

/** The cron sweep re-reads a Claude account's reset grants at most this often (see `quotaProbeTarget`). */
const GRANT_SWEEP_TTL_MS = 6 * 60 * 60_000;

/** How long the cron sweep trusts a stored "not eligible" status (new grants can make the account eligible). */
const GRANT_INELIGIBLE_TTL_MS = 24 * 60 * 60_000;

const decodeLease = Schema.decodeUnknownSync(Lease);

const decodeReportResult = Schema.decodeUnknownSync(ReportResult);

const decodeRetryQuery = Schema.decodeUnknownSync(RetryQuery);

const PROTECTED_KEYS = new Set([
  "type",
  "disabled",
  "api_key",
  "dca_token",
  "dca_expired",
  "dca_expires_at",
]);

/** Keys `patchCredentialMetadata` must not write: token lifecycle, identity of the provider, the disabled flag. */
const isProtectedMetadataKey = (key: string): boolean =>
  isTokenPayloadKey(key) || PROTECTED_KEYS.has(key);

/** Token refreshes one batch runs at once (each is an upstream call made by this object). */
const BATCH_REFRESH_CONCURRENCY = 4;

const NOT_FOUND: Omit<AccountResult, "name"> = {
  ok: false,
  error: "not_found",
  message: "auth file not found",
};

/** A batch named a config API key (by its `auth_index`, the name the Accounts page lists it under). */
const CONFIG_CREDENTIAL: Omit<AccountResult, "name"> = {
  ok: false,
  error: "config_credential",
  message: "config API keys are managed on the API keys page",
};

/** The shape of an `auth_index` (`management/auth-index.ts`): only such names are looked up as one. */
const AUTH_INDEX_PATTERN = /^[0-9a-f]{16}$/;

const isDisablingPattern = (pattern: string): boolean => pattern.trim() === "*";

/** On the Accounts page: auth files, and config API keys whose provider reports quota with the key. */
const listed = ({ credential }: RefreshTarget): boolean =>
  credential.source === "file" ||
  (credential.source === "config" && isConfigQuotaProvider(executorKey(credential)));

/**
 * A failed batch refresh as the panel shows it: a fixed reason per failure code plus the upstream status. The
 * refresher's own message is never passed on: it can quote the upstream body, which may echo the refresh token.
 */
const REFRESH_REASONS = new Map([
  ["unauthorized", "the provider refused the refresh token"],
  ["disabled", "the account is disabled"],
  ["persist_failed", "the new tokens could not be stored"],
]);

const refreshFailure = (
  name: string,
  error: { readonly code: string; readonly httpStatus?: number },
): AccountResult => {
  const reason = REFRESH_REASONS.get(error.code) ?? "the token refresh failed";
  const status = error.httpStatus;

  return {
    name,
    ok: false,
    error: error.code === "unauthorized" ? "unauthorized" : "refresh_failed",
    message: status === undefined ? reason : `${reason} (HTTP ${status})`,
    ...(status === undefined ? {} : { status }),
  };
};

/** Stored under `recordQuotaReport`: the report, or why it was not stored. */
export type RecordQuotaResult =
  | { readonly kind: "stored"; readonly report: QuotaReport }
  | { readonly kind: "gone" }
  /** The credential's tokens changed during the check: the outcome says nothing about the new ones. */
  | { readonly kind: "stale" };

/** JSON object as it crosses the RPC boundary (the recursive `JsonObject` is too deep for the RPC stub types). */
type WireJsonObject = Record<string, Schema.MutableJson>;

/** Answer of the `settleResetGrantClaim` RPC: whether cooldowns were cleared, and the claim still open. */
export interface SettledResetGrantClaim {
  readonly cooldownCleared: boolean;
  readonly pending?: PendingResetClaim;
}

/** Answer of the `resetGrantTarget` RPC. */
export type ResetGrantTargetResult =
  | {
      readonly ok: true;
      readonly id: string;
      readonly token: string;
      /** The grant state the Worker's status read is based on (`reset-grant-store.ts`). */
      readonly mark: ResetGrantMark;
      readonly disabled: boolean;
      readonly pending?: PendingResetClaim;
      /** The request id of `pending`, which a resend names (`beginResetGrantClaim`); a nonce, not a secret. */
      readonly pendingRequestId?: string;
    }
  | { readonly ok: false; readonly error: "not_found" }
  | { readonly ok: false; readonly error: "unsupported"; readonly provider: string }
  | { readonly ok: false; readonly error: "unavailable"; readonly message: string };

export type SetDisabledResult =
  | { readonly ok: true; readonly via?: "config:excluded-models" }
  | {
      readonly ok: false;
      readonly error: "not_found" | "config_credential" | "compat_endpoint" | "invalid";
      readonly message?: string;
    };

/**
 * One Durable Object per org (`controlPlaneOf(env, org)`, named by the org id; ADR 0021): the single writer for the
 * org's config, credentials, cooldown state and refresh scheduling (see docs/ARCHITECTURE.md).
 *
 * Implements the config store, the credential store/selection (`pick`, `report`, credential management) and OAuth
 * token refresh (`alarm`, `refreshNow`, `ensureFresh`, `sweepRefresh`; see `refresh/manager.ts`). Methods are exposed to the Worker through JS RPC and exchange plain data only.
 */
export class ControlPlane extends DurableObject<Env> {
  readonly #config: ConfigStore;
  readonly #pool: CredentialPool;
  readonly #refresh: RefreshManager;
  readonly #oauth: OAuthService;
  readonly #quota: QuotaReportStore;
  readonly #sweepLease: SweepLeaseStore;
  readonly #grants: ResetGrantStore;
  /** The org this object serves, from its name. */
  readonly #org: OrgId;
  /**
   * The org's keyed `auth_index` (`orgAuthIndexer`, cached per isolate). Resolved per call so a refused key fails the
   * calls that need an index, not the Durable Object's constructor.
   */
  readonly #authIndex: AuthIndexer = (credentialId) =>
    orgAuthIndexer(this.env, this.#org)(credentialId);
  #configView: ConfigView | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#org = orgOfControlPlane(ctx.id);
    this.#config = new ConfigStore(ctx.storage.sql, this.#org);
    this.#quota = new QuotaReportStore(ctx.storage.sql);
    this.#sweepLease = new SweepLeaseStore(ctx.storage.sql, () => Date.now());

    this.#grants = new ResetGrantStore(ctx.storage.sql);
    this.#pool = new CredentialPool({
      store: new CredentialStore(ctx.storage.sql),
      config: () => this.#currentConfig(),
      decorate: (credential) => this.#refresh.decorate(credential),
    });
    this.#refresh = new RefreshManager({
      host: this.#pool,
      alarm: {
        set: (at) => ctx.storage.setAlarm(at),
        clear: () => ctx.storage.deleteAlarm(),
      },
      http: FetchHttpClient.layer,
      metaMintUrl: env.META_MINT_URL,
      workers: () => this.#currentConfig().config.oauth["auth-auto-refresh-workers"],
    });
    this.#oauth = makeOAuthService({
      org: this.#org,
      metaMintUrl: env.META_MINT_URL,
      sessions: new OAuthSessions(new SqliteSessionTable(ctx.storage.sql)),
      sink: {
        get: (name) => this.#pool.refreshTarget(name)?.credential.metadata,
        list: () =>
          this.#pool.refreshTargets().map(({ credential }) => ({
            id: credential.id,
            type: typeof credential.metadata.type === "string" ? credential.metadata.type : "",
            metadata: credential.metadata,
          })),
        save: async (name, metadata) => {
          const result = this.#upsert(name, metadata, false);

          if (!result.ok) return { ok: false, message: result.message };
          await this.#rearm();

          return { ok: true };
        },
        remove: async (id) => {
          await this.removeCredential(id);
        },
      },
    });
  }

  /** Decoded config, re-decoded only when the stored version changed. */
  #currentConfig(): ConfigView {
    const cached = this.#configView;
    const snapshot = this.#config.get(cached?.version);

    if (cached !== undefined && snapshot.unchanged) return cached;
    const config: Config = Effect.runSync(decodeStoredConfig(snapshot.document ?? ""));
    this.#configView = { version: snapshot.version, config };

    return this.#configView;
  }

  /**
   * Current config document. Pass the version already cached by the caller to get a cheap `unchanged: true`
   * answer instead of the full document.
   */
  getConfig(sinceVersion?: number): ConfigSnapshotWire {
    return this.#config.get(sinceVersion);
  }

  /**
   * Replaces the config with `text` (YAML or JSON). Returns a structured result instead of throwing so validation
   * and version-conflict errors survive the RPC boundary. `expectedVersion` enables optimistic concurrency.
   */
  putConfig(text: string, expectedVersion?: number): PutConfigResult {
    return this.#config.put(text, expectedVersion);
  }

  /**
   * Selects a credential for `request` (candidate set, availability, priority tiers, strategy, session affinity) and
   * returns everything the executor needs plus a lease to hand back to {@link report}. A failure to select is a
   * structured result (`ok: false`), not an exception.
   */
  pick(request: PickRequest): PickResult {
    return this.#pool.pick(decodePickRequest(request));
  }

  /**
   * Reports the outcome of the attempt that used `lease` (counters, cooldown/quota state machine, session affinity).
   */
  report(lease: Lease, result: ReportResult): ReportOutcome {
    return this.#pool.report(decodeLease(lease), decodeReportResult(result));
  }

  /** What the model registry needs from every credential (provider, prefix, exclusions, aliases, model state); no secrets. */
  listModelSources(): ModelSource[] {
    return this.#pool.modelSources();
  }

  /**
   * After a failed retry round: should another round start and how long should the Worker wait first?
   * (`request-retry`, cooldown recovery times, `max-retry-interval`; credentials.md §7.1.)
   */
  planRetry(query: RetryQuery): RetryPlan {
    return this.#pool.planRetry(decodeRetryQuery(query));
  }

  /** All credentials with runtime state; token material is redacted. */
  listCredentials(): CredentialSummary[] {
    return this.#pool.list();
  }

  /**
   * Creates or replaces the auth file `name` (parsed object or JSON text). `mergeExisting` (default true) carries user
   * settings of the previous file over, as a re-login does.
   */
  async upsertCredential(
    name: string,
    content: string | JsonObject,
    options?: { mergeExisting?: boolean },
  ): Promise<UpsertResult> {
    const result = this.#upsert(name, content, options?.mergeExisting ?? true);

    if (result.ok) await this.#rearm();

    return result;
  }

  /**
   * Imports a Go auth JSON file verbatim (an existing credential of the same name is replaced; `mergeExisting` keeps
   * its user settings like a re-login).
   */
  async importAuthFile(
    name: string,
    content: string | JsonObject,
    options: { readonly mergeExisting?: boolean } = {},
  ): Promise<UpsertResult> {
    const result = this.#upsert(name, content, options.mergeExisting === true);

    if (result.ok) await this.#rearm();

    return result;
  }

  /** Removes a stored credential and its runtime state. */
  async removeCredential(id: string): Promise<{ readonly removed: boolean }> {
    const removed = this.#pool.remove(id);

    if (removed) {
      this.#refresh.forget(id);
      this.#quota.delete(id);
      this.#grants.forget(id);
      await this.#rearm();
    }

    return { removed };
  }

  /** Removes several stored credentials; returns the ids that existed. */
  async removeCredentials(ids: ReadonlyArray<string>): Promise<string[]> {
    const removed = this.#removeMany(ids);

    if (removed.length > 0) await this.#rearm();

    return removed;
  }

  /**
   * Removes stored credentials in one storage transaction, clearing what {@link removeCredential} clears for each:
   * the credential with its runtime (cooldown) state and session bindings, its quota report, its reset grants (a claim
   * in flight is kept, `ResetGrantStore.forget`), and the refresher's in-memory state. The caller re-arms the refresh alarm once.
   */
  #removeMany(ids: ReadonlyArray<string>): string[] {
    const removed = this.#pool.removeMany(ids, (write) =>
      this.ctx.storage.transactionSync(() => {
        const gone = write();

        for (const id of gone) {
          this.#quota.delete(id);
          this.#grants.forget(id);
        }

        return gone;
      }),
    );

    for (const id of removed) this.#refresh.forget(id);

    return removed;
  }

  /** Disables or re-enables a stored credential (persisted as `disabled` in its file JSON). */
  async setCredentialDisabled(id: string, disabled: boolean): Promise<SetDisabledResult> {
    const result = this.#pool.setDisabled(id, disabled);

    if (result !== "ok") return { ok: false, error: result };
    await this.#rearm();

    return { ok: true };
  }

  // --- token refresh (refresh/manager.ts) ----------------------------------------------------------------------

  /** Durable Object alarm: refreshes due credentials and re-arms the single multiplexed alarm. */
  override async alarm(): Promise<void> {
    await this.#refresh.onAlarm();
  }

  /**
   * Request-time refresh after the upstream answered 401 (`tryRefreshAfterUnauthorized`): pass the access token that
   * was rejected so concurrent 401s share one refresh and an already replaced token is not refreshed again. On success
   * the executor retries once with `credential.metadata.access_token`. Never throws: failures are structured.
   */
  refreshNow(credentialId: string, rejectedAccessToken?: string): Promise<RefreshResult> {
    const options: RefreshOptions =
      rejectedAccessToken === undefined ? {} : { rejectedAccessToken };

    return this.#refresh.refreshNow(credentialId, options);
  }

  /** Manual refresh (management): ignores the terminal-unauthorized gating. */
  forceRefresh(credentialId: string): Promise<RefreshResult> {
    return this.#refresh.refreshNow(credentialId, { force: true });
  }

  /**
   * Returns the credential ready to use: a cached/minted Vertex service-account token, a minted Meta key, or a
   * refreshed OAuth token when the stored one is missing/expired (Antigravity: within 5 min). Executors call it when
   * the picked snapshot has no usable `metadata.access_token`.
   */
  ensureFresh(credentialId: string): Promise<RefreshResult> {
    return this.#refresh.ensureFresh(credentialId);
  }

  /** Cron safety sweep: refreshes what is overdue and re-arms a lost alarm. */
  sweepRefresh(): Promise<RunSummary> {
    return this.#refresh.sweep();
  }

  /** Cron task `devin-user-status`: `GetUserStatus` profile and quota signals of every stored Devin credential. */
  async refreshDevinStatus(): Promise<DevinStatusSummary> {
    const summary = await Effect.runPromise(
      refreshDevinStatuses(this.#pool).pipe(Effect.provide(FetchHttpClient.layer)),
    );

    if (summary.refreshed > 0) await this.#rearm();

    return summary;
  }

  /**
   * Merges non-token settings into a stored credential's file (`UpdatePreparedAuth`: request preparation results such
   * as Antigravity `project_id` or Claude profile fields). `null` deletes a key. Token material, `type` and
   * `disabled` cannot be written here.
   */
  async patchCredentialMetadata(
    credentialId: string,
    patch: JsonObject,
  ): Promise<
    { readonly ok: true } | { readonly ok: false; readonly error: "not_found" | "forbidden_key" }
  > {
    const target = this.#pool.refreshTarget(credentialId);

    if (target === undefined) return { ok: false, error: "not_found" };

    if (Object.keys(patch).some(isProtectedMetadataKey))
      return { ok: false, error: "forbidden_key" };
    const metadata: JsonObject = { ...target.credential.metadata };

    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete metadata[key];
      else metadata[key] = value;
    }

    this.#pool.commitRefresh(credentialId, { metadata });
    await this.#rearm();

    return { ok: true };
  }

  // --- management API (src/management) -------------------------------------------------------------------------

  /**
   * Panel entries of all stored auth files, plus the config API keys whose provider reports quota with the key
   * (`CONFIG_QUOTA_PROVIDERS`, listed by their `auth_index`, `buildConfigCredentialEntry`). No secrets.
   */
  listCredentialEntries(): WireJsonObject[] {
    const now = Date.now();
    const reports = this.#quota.all();
    const grants = this.#grants.statuses();
    const entries = this.#pool.entries();

    const ids = entries.some(({ credential }) => credential.source === "config")
      ? configKeyIds(this.#currentConfig().config)
      : undefined;

    return entries.filter(listed).map(({ credential, state }) => {
      if (credential.source === "config") {
        const position = ids === undefined ? undefined : locateKey(ids, credential.id);

        return buildConfigCredentialEntry(
          credential,
          state,
          now,
          this.#authIndex,
          position === undefined ? undefined : { family: position.family, index: position.group },
          reports.get(credential.id),
        );
      }

      return buildCredentialEntry(
        credential,
        state,
        now,
        this.#authIndex,
        reports.get(credential.id),
        grants.get(credential.id),
      );
    });
  }

  /**
   * The listed config account (`CONFIG_QUOTA_PROVIDERS`) whose listed name, its keyed `auth_index`, is `name`. An index
   * reveals nothing about the key, so resolving one confirms no guess.
   */
  #configAccount(name: string): RefreshTarget | undefined {
    const index = name.trim().toLowerCase();

    if (!AUTH_INDEX_PATTERN.test(index)) return undefined;

    return this.#pool
      .entries()
      .find(
        ({ credential }) =>
          credential.source === "config" &&
          isConfigQuotaProvider(executorKey(credential)) &&
          this.#authIndex(credential.id) === index,
      );
  }

  /**
   * Whether `name` is the `auth_index` of a config API key: the management routes answer a file-only operation on one
   * (delete, download, refresh, field edits) with a clear refusal instead of "not found".
   */
  isConfigKey(name: string): boolean {
    const index = name.trim().toLowerCase();

    if (!AUTH_INDEX_PATTERN.test(index)) return false;

    return (
      findCredential(this.#pool.entries(), { authIndex: index }, this.#authIndex)?.credential
        .source === "config"
    );
  }

  /** The stored auth file verbatim, for download. */
  getCredentialFile(name: string): WireJsonObject | undefined {
    return this.#pool.refreshTarget(name)?.credential.metadata;
  }

  /** Edits fields of a stored auth file (`PATCH /credentials/fields`); see `field-patch.ts`. */
  async patchCredentialFields(
    ref: CredentialRef,
    fields: WireJsonObject,
  ): Promise<CredentialMutation> {
    const target = findCredential(this.#pool.entries(), ref, this.#authIndex);

    if (target === undefined || target.credential.source !== "file") {
      return { ok: false, error: "not_found", message: "auth file not found" };
    }

    const patched = applyFieldPatch(target.credential.metadata, fields);

    if (!patched.ok) {
      return {
        ok: false,
        error: "invalid",
        message: patched.message,
        ...(patched.path === undefined ? {} : { path: patched.path }),
      };
    }

    this.#pool.commitRefresh(target.credential.id, { metadata: patched.metadata });
    await this.#rearm();

    return { ok: true, id: target.credential.id };
  }

  /**
   * Enables/disables a credential addressed by file name and/or `auth_index`. A config API key is disabled by
   * adding `*` to its `excluded-models` in the config (Go `toggleConfigAPIKeyExcludedAll`); the credential id and
   * `auth_index` stay the same (`excluded-models` is not part of the identity).
   */
  async setCredentialDisabledByRef(
    ref: CredentialRef,
    disabled: boolean,
  ): Promise<SetDisabledResult> {
    const target = findCredential(this.#pool.entries(), ref, this.#authIndex);

    if (target === undefined) return { ok: false, error: "not_found" };

    if (target.credential.source === "config")
      return this.#setConfigKeyDisabled(target.credential, disabled);

    return await this.setCredentialDisabled(target.credential.id, disabled);
  }

  #setConfigKeyDisabled(credential: Credential, disabled: boolean): SetDisabledResult {
    // Go has no compat loop in config_apikey_disable.go: an endpoint is disabled as a whole (`disabled` on its group).
    if (credential.attributes.compat_name !== undefined)
      return { ok: false, error: "compat_endpoint" };
    const view = this.#currentConfig();
    const snapshot = this.#config.get();
    const position = locateKey(configKeyIds(view.config), credential.id);

    if (position === undefined) return { ok: false, error: "not_found" };
    // SAFETY: the stored config document is always a serialized JSON object (writes reject non-objects).
    const document = JSON.parse(snapshot.document ?? "{}") as JsonObject;

    const edit = setKeyExcludedAll(document, position, disabled);

    if (!edit.ok) return { ok: false, error: "not_found" };
    // Synchronous read-check-write: nothing can interleave, the version check only documents that.
    const stored = this.#config.put(JSON.stringify(edit.value), snapshot.version);

    return stored.ok
      ? { ok: true, via: "config:excluded-models" }
      : { ok: false, error: "invalid", message: stored.message };
  }

  // --- API keys page (src/management/api-keys-*.ts) ------------------------------------------------------------

  /** The `api-keys` groups with runtime state: one snapshot of config version and credential pool (no secrets). */
  apiKeysView(): WireJsonObject {
    const { version, config } = this.#currentConfig();

    return buildApiKeysList(version, config, this.#pool.entries(), Date.now(), this.#authIndex);
  }

  /**
   * The id of the live credential (auth file or config key) whose `auth_index` is `authIndex`, for the usage filter
   * (`resolveAuthIds`): it narrows D1 to that id without scanning the distinct ids. Internal: never sent to a client.
   */
  credentialIdOfAuthIndex(authIndex: string): string | undefined {
    return findCredential(this.#pool.entries(), { authIndex }, this.#authIndex)?.credential.id;
  }

  /**
   * What the Worker needs to probe a config API key (`POST /api-keys/probe`): the family, base URL, headers and the
   * key itself. Carries the secret: the Worker uses it for the upstream call only and never returns it.
   */
  apiKeyProbeTarget(authIndex: string): ApiKeyProbeTargetResult {
    const target = findCredential(this.#pool.entries(), { authIndex }, this.#authIndex);

    const probe =
      target?.credential.source === "config"
        ? buildApiKeyProbeTarget(target.credential)
        : undefined;

    return probe === undefined ? { ok: false, error: "not_found" } : { ok: true, target: probe };
  }

  /** Clears quota/cooldown state (`POST /routing/cooldown/reset`). */
  resetCredentialCooldown(
    ref: CredentialRef,
  ):
    | { readonly ok: true; readonly authIndex: string; readonly models: ReadonlyArray<string> }
    | { readonly ok: false } {
    const target = findCredential(this.#pool.entries(), ref, this.#authIndex);
    const reset = target === undefined ? undefined : this.#pool.resetCooldown(target.credential.id);

    return target === undefined || reset === undefined
      ? { ok: false }
      : { ok: true, authIndex: this.#authIndex(target.credential.id), models: reset.models };
  }

  /** Manual refresh of one auth file (`POST /credentials/refresh`). */
  async refreshCredential(ref: CredentialRef): Promise<RefreshOneResult> {
    const target = findCredential(this.#pool.entries(), ref, this.#authIndex);

    if (target === undefined || target.credential.source !== "file")
      return { ok: false, error: "not_found" };
    const id = target.credential.id;
    const result = await this.#refresh.refreshNow(id, { force: true });

    if (!result.ok && result.error.code !== "not_refreshable") {
      return { ok: false, error: "refresh_failed", message: result.error.message };
    }

    const current = this.#pool.entry(id);

    if (current === undefined) return { ok: false, error: "not_found" };

    return {
      ok: true,
      refreshed: result.ok && result.refreshed,
      entry: buildCredentialEntry(
        current.credential,
        current.state,
        Date.now(),
        this.#authIndex,
        this.#quota.get(id),
        this.#grants.status(id),
      ),
    };
  }

  /** Manual refresh of every refreshable auth file (`all=true`). */
  async refreshAllCredentials(): Promise<RefreshAllItem[]> {
    const results = await Promise.all(
      this.#pool.refreshTargets().map(async ({ credential }) => ({
        id: credential.id,
        result: await this.#refresh.refreshNow(credential.id, { force: true }),
      })),
    );

    const items: RefreshAllItem[] = [];

    for (const { id, result } of results) {
      if (result.ok) items.push({ id, success: true });
      // Credentials without a refresh token are not part of a refresh run.
      else if (result.error.code !== "not_refreshable")
        items.push({ id, success: false, error: result.error.message });
    }

    return items;
  }

  /**
   * One batch action over auth files named by id (`POST /credentials/batch`, src/management/credentials-batch.ts):
   * one result per name, in order. Every name is resolved against one snapshot of the stored credentials.
   *
   * Enable, disable and delete apply every name in one synchronous pass inside a storage transaction (nothing
   * interleaves, and a failure leaves no half-applied batch), dropping the pool's derived view once, then re-arm the
   * refresh alarm once. A batch delete clears exactly what a single delete clears: the credential with its runtime
   * (cooldown) state and session bindings, its quota report and the refresher's in-memory state. A name that is no
   * longer stored is already deleted, so a delete answers it `ok`, a config API key's id included: answering it
   * `not_found` would confirm a guessed config id, i.e. a guessed API key (`auth-index.ts`). Enable, disable and
   * refresh answer every name that is no stored auth file `not_found`, config ids or not.
   *
   * Refresh forces each refresh with at most {@link BATCH_REFRESH_CONCURRENCY} upstream calls at a time; an account
   * without a refresh token is `skipped`, and a failure carries a fixed reason (`refreshFailure`).
   */
  async batchCredentials(
    action: BatchAction,
    names: ReadonlyArray<string>,
  ): Promise<AccountResult[]> {
    const stored = new Set(this.#pool.refreshTargets().map(({ credential }) => credential.id));

    // Config API keys listed on the Accounts page by their `auth_index` (public, so a clear answer confirms nothing).
    const configKeys = new Set(names.filter((name) => !stored.has(name) && this.isConfigKey(name)));

    if (action === "refresh") {
      return await Effect.runPromise(
        Effect.forEach(
          names,
          (name) =>
            stored.has(name)
              ? Effect.promise(() => this.#refreshForBatch(name))
              : Effect.succeed<AccountResult>({
                  name,
                  ...(configKeys.has(name) ? CONFIG_CREDENTIAL : NOT_FOUND),
                }),
          { concurrency: BATCH_REFRESH_CONCURRENCY },
        ),
      );
    }

    const known = names.filter((name) => stored.has(name));

    const applied = new Set(
      action === "delete"
        ? this.#removeMany(known)
        : this.#pool.setDisabledMany(known, action === "disable", (write) =>
            this.ctx.storage.transactionSync(write),
          ),
    );

    if (applied.size > 0) await this.#rearm();

    return names.map((name): AccountResult => {
      if (applied.has(name)) return { name, ok: true };

      if (configKeys.has(name)) return { name, ...CONFIG_CREDENTIAL };

      // Gone already (here or in a concurrent call), or never an auth file: no auth file of that name is stored, as a
      // delete asked. A config id reads like any other such name, so the reply does not confirm a guessed key.
      if (action === "delete") return { name, ok: true };

      return { name, ...NOT_FOUND };
    });
  }

  async #refreshForBatch(name: string): Promise<AccountResult> {
    const result = await this.#refresh.refreshNow(name, { force: true });

    if (result.ok) return { name, ok: true };

    if (result.error.code === "not_found") return { name, ...NOT_FOUND };

    if (result.error.code === "not_refreshable") {
      return {
        name,
        ok: false,
        skipped: true,
        error: "not_refreshable",
        message: "the account has no refresh token",
      };
    }

    return refreshFailure(name, result.error);
  }

  // --- quota check (src/quota) ----------------------------------------------------------------------------------

  /**
   * What the Worker needs to probe the usage endpoint of an auth file (`POST /credentials/quota`, cron `quota-check`):
   * the provider and the token of the credential refreshed when needed, with the `credentialVersion` the token belongs
   * to (handed back with the outcome, see {@link recordQuotaReport}). Carries token material: the Worker uses it for
   * the upstream call only. A Claude target carries the grant `grantsMark`; in a sweep (`sweep`) it skips the reset
   * grant read while the stored status is under `GRANT_SWEEP_TTL_MS` old, or under `GRANT_INELIGIBLE_TTL_MS` old when
   * it says the account is not eligible.
   */
  async quotaProbeTarget(
    ref: CredentialRef,
    options?: { readonly sweep?: boolean },
  ): Promise<QuotaTargetResult> {
    const target =
      findCredential(this.#pool.entries(), ref, this.#authIndex) ??
      (ref.name === undefined ||
      (ref.authIndex !== undefined &&
        ref.authIndex.trim().toLowerCase() !== ref.name.trim().toLowerCase())
        ? undefined
        : this.#configAccount(ref.name));

    if (target === undefined || !listed(target)) return { ok: false, error: "not_found" };
    const provider = executorKey(target.credential);

    if (!isQuotaProvider(provider)) return { ok: false, error: "unsupported", provider };
    const id = target.credential.id;

    // A config key needs no refresh: the target is built from the pool's credential, named by its `auth_index`.
    if (target.credential.source === "config") {
      const built = buildQuotaTarget(target.credential, provider);
      const credentialVersion = target.credential.credentialVersion;
      const handle = this.#authIndex(id);

      if (!built.ok) return built.error === "unavailable" ? { ...built, credentialVersion } : built;

      return { ok: true, target: { ...built.target, handle, credentialVersion } };
    }

    const fresh = await this.#refresh.ensureFresh(id);

    if (!fresh.ok) {
      return {
        ok: false,
        error: "unavailable",
        id,
        message: "token refresh failed",
        credentialVersion: target.credential.credentialVersion,
      };
    }

    const built = buildQuotaTarget(fresh.credential, provider);
    const credentialVersion = fresh.credential.credentialVersion;

    if (!built.ok) return built.error === "unavailable" ? { ...built, credentialVersion } : built;

    if (provider !== "claude")
      return { ok: true, target: { ...built.target, handle: id, credentialVersion } };
    const stored = this.#grants.status(id);

    const skip =
      options?.sweep === true &&
      stored !== undefined &&
      Date.now() - Date.parse(stored.checked_at) <
        (stored.eligible ? GRANT_SWEEP_TTL_MS : GRANT_INELIGIBLE_TTL_MS);

    return {
      ok: true,
      target: {
        ...built.target,
        handle: id,
        credentialVersion,
        ...(skip ? { skipResetGrants: true } : {}),
      },
      grantsMark: this.#grants.mark(id),
    };
  }

  /**
   * Stores the result of one quota check made at `checkedAtMs` with the tokens of `credentialVersion`: `gone` when the
   * credential was deleted meanwhile, `stale` (nothing stored) when its tokens changed meanwhile (a re-login), as a
   * refresh result is dropped. `sweepLease`: the check is part of a sweep, whose lease this renews.
   */
  recordQuotaReport(
    id: string,
    outcome: QuotaOutcome,
    checkedAtMs: number,
    options: {
      readonly credentialVersion?: number;
      readonly sweepLease?: string;
      readonly grantsMark?: ResetGrantMark;
    } = {},
  ): RecordQuotaResult {
    if (options.sweepLease !== undefined) this.#sweepLease.renew(options.sweepLease);
    const current = this.#pool.entry(id);

    if (current === undefined) return { kind: "gone" };

    if (
      options.credentialVersion !== undefined &&
      current.credential.credentialVersion !== options.credentialVersion
    )
      return { kind: "stale" };

    const report = mergeQuotaReport(
      this.#quota.get(id),
      outcome,
      new Date(checkedAtMs).toISOString(),
    );

    this.#quota.put(id, report);

    // A stale outcome returned above stores no grant status either; the grant mark guards against re-logins and claims.
    if (outcome.ok && outcome.resetGrants !== undefined && options.grantsMark !== undefined)
      this.#grants.putStatus(id, outcome.resetGrants, options.grantsMark);

    return { kind: "stored", report };
  }

  // --- Claude reset grants (src/quota/reset-grant-flow.ts) ------------------------------------------------------

  /**
   * What the Worker needs to read or claim the reset grants of a Claude auth file: the fresh OAuth token and the claim
   * that can still be resent, the grant `mark` its status read is based on and whether the account is disabled.
   * Carries token material: the Worker uses it for the upstream calls only.
   */
  async resetGrantTarget(ref: CredentialRef): Promise<ResetGrantTargetResult> {
    const target = findCredential(this.#pool.entries(), ref, this.#authIndex);

    if (target === undefined || target.credential.source !== "file")
      return { ok: false, error: "not_found" };
    const provider = executorKey(target.credential);

    if (provider !== "claude") return { ok: false, error: "unsupported", provider };
    const id = target.credential.id;
    const fresh = await this.#refresh.ensureFresh(id);

    if (!fresh.ok) return { ok: false, error: "unavailable", message: "token refresh failed" };
    const token = apiCallToken(fresh.credential);

    if (token === "")
      return { ok: false, error: "unavailable", message: "credential has no access token" };
    const now = Date.now();
    const open = openClaim(this.#grants.claim(id), now);

    return {
      ok: true,
      id,
      token,
      mark: this.#grants.mark(id),
      disabled: target.credential.disabled,
      ...(open === undefined
        ? {}
        : { pending: pendingClaimJson(open, now), pendingRequestId: open.request_id }),
    };
  }

  /**
   * Stores a reset grant status read under `mark` (`ResetGrantStore.putStatus`); `gone` when the credential was
   * removed.
   */
  recordResetGrantStatus(
    id: string,
    status: ResetGrantStatus,
    mark: ResetGrantMark,
  ): PutStatusResult | "gone" {
    if (this.#pool.entry(id) === undefined) return "gone";

    return this.#grants.putStatus(id, status, mark);
  }

  /**
   * Starts a claim (`reset-grants.ts` `beginClaim`): resends the open claim of `organization` whose request id is
   * `resend`, or starts `fresh` when nothing happened to the grants since `mark` was handed out. Serialized here, so
   * two tabs or admins never send two claims of one account at once, nor two auth files of one organization. Refused
   * for a disabled account and when the credential was replaced or removed since `mark` (`changed`).
   */
  beginResetGrantClaim(
    id: string,
    organization: string,
    fresh: FreshClaim | undefined,
    mark: ResetGrantMark,
    resend?: string,
  ):
    | BeginClaim
    | {
        readonly ok: false;
        readonly error: "not_found" | "disabled" | "changed" | "busy_removed";
      } {
    const entry = this.#pool.entry(id);

    if (entry === undefined) return { ok: false, error: "not_found" };

    if (entry.credential.disabled) return { ok: false, error: "disabled" };
    const current = this.#grants.mark(id);

    if (current.generation !== mark.generation) return { ok: false, error: "changed" };

    const now = Date.now();
    const others = [...this.#grants.claims()].filter(([other]) => other !== id);
    const own = this.#grants.claim(id);

    const started = beginClaim(
      own,
      {
        organization,
        fresh,
        resend,
        current: current.claimSeq === mark.claimSeq,
        others: others.map(([, journal]) => journal),
      },
      now,
    );

    if (started.ok) this.#grants.putClaim(id, started.journal);
    else if (
      started.error === "busy" &&
      !(own !== undefined && own.in_flight_until > now) &&
      others.some(
        ([other, journal]) =>
          this.#pool.entry(other) === undefined && holdsOrganization(journal, organization, now),
      )
    )
      // Held by the claim of a removed auth file: its journal outlived the file (`ResetGrantStore.forget`).
      return { ok: false, error: "busy_removed" };

    return started;
  }

  /**
   * Records Anthropic's answer to the claim `requestId`, also after the credential was removed or re-logged (its journal
   * outlives `forget` while in flight). When it spent a reset the account's cooldowns are cleared (`resetCooldown`, as
   * `POST /routing/cooldown/reset`): the windows that made it cool down were reset upstream.
   */
  settleResetGrantClaim(
    id: string,
    requestId: string,
    answer: ClaimAnswer,
  ): SettledResetGrantClaim {
    const settled = settleClaim(this.#grants.claim(id), requestId, answer);

    this.#grants.putClaim(id, settled.journal);

    if (this.#pool.entry(id) === undefined) return { cooldownCleared: false };
    const cleared = settled.spent && this.#pool.resetCooldown(id) !== undefined;
    const now = Date.now();
    const open = openClaim(settled.journal, now);

    return {
      cooldownCleared: cleared,
      ...(open === undefined ? {} : { pending: pendingClaimJson(open, now) }),
    };
  }

  /**
   * Listed names of the enabled accounts whose provider has a usage endpoint (cron `quota-check`, "Check all
   * quotas"): auth file names, and the `auth_index` of each listed config API key without `*` in its
   * `excluded-models` ({@link quotaProbeTarget} resolves both). Reports of credentials that no longer exist (a config
   * key whose identity changed with an edit, its id being content-addressed) are dropped here.
   */
  quotaCheckTargets(): string[] {
    const entries = this.#pool.entries();

    this.#quota.retain(new Set(entries.map(({ credential }) => credential.id)));

    return entries
      .filter((entry) => {
        const { credential } = entry;

        if (!listed(entry) || !isQuotaProvider(executorKey(credential))) return false;

        return credential.source === "config"
          ? !credential.excludedModels.some(isDisablingPattern)
          : !credential.disabled;
      })
      .map(({ credential }) =>
        credential.source === "config" ? this.#authIndex(credential.id) : credential.id,
      );
  }

  /**
   * Takes the lease of a check of every quota (src/quota/sweep-lease.ts) at this object's own time; refused while a
   * live sweep holds it.
   */
  takeQuotaSweepLease(source: SweepSource): TakeLease {
    return this.#sweepLease.take(source);
  }

  /** Marks the sweep holding `token` alive; `false` when it no longer holds the lease. */
  renewQuotaSweepLease(token: string): boolean {
    return this.#sweepLease.renew(token);
  }

  /** Gives back the lease taken with `token` (a lease taken over meanwhile is left alone). */
  releaseQuotaSweepLease(token: string): void {
    this.#sweepLease.release(token);
  }

  // --- provider OAuth logins (src/oauth) ------------------------------------------------------------------------

  /** Starts a provider login (`GET /oauth/auth-url`): returns the URL to open and the session `state`. */
  oauthStart(input: StartInput): Promise<StartResult> {
    return this.#runOAuth(this.#oauth.start(input));
  }

  /** `GET /oauth/status`: pending/ok/error; for device logins each call advances the upstream poll when due. */
  oauthStatus(state: string): Promise<StatusResult> {
    return this.#runOAuth(this.#oauth.status(state));
  }

  /** Completes a callback login from a pasted/redirected `code` + `state` (management and public browser routes). */
  oauthCallback(input: CallbackInput): Promise<CallbackResult> {
    return this.#runOAuth(this.#oauth.callback(input));
  }

  /** `DELETE /oauth/session`: cancels a pending login. */
  oauthCancel(state: string): Promise<{ readonly cancelled: boolean }> {
    return Effect.runPromise(this.#oauth.cancel(state));
  }

  #runOAuth<A>(effect: Effect.Effect<A, never, HttpClient.HttpClient>): Promise<A> {
    return Effect.runPromise(effect.pipe(Effect.provide(FetchHttpClient.layer)));
  }

  /**
   * Stores an auth file. Replacing the token material of an existing credential (a re-login, possibly into another
   * account) drops its quota report and reset grants, which described the previous tokens.
   */
  #upsert(name: string, content: string | JsonObject, mergeExisting: boolean): UpsertResult {
    const result = this.#pool.upsert(name, content, { mergeExisting });

    if (result.ok && result.credentialsChanged && !result.created) {
      this.#quota.delete(result.id);
      this.#grants.forget(result.id);
    }

    return result;
  }

  /** Credential changes move refresh deadlines; a failure to re-arm must never fail the management call. */
  async #rearm(): Promise<void> {
    await this.#refresh.rearm().catch(() => undefined);
  }
}
