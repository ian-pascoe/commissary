// The typed management API client (generated from the shared contract) and the atoms the pages read. Calls go to the
// panel's own origin; Cloudflare Access authenticates them with the session cookie, so no credentials live here.
import { Cause, Clock, Duration, Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest } from "effect/http";
import { Atom, AtomHttpApi, Reactivity } from "effect/reactivity";
import { ManagementApi } from "#contract/api.ts";
import { type BatchAction, batchLimit } from "#contract/credentials.ts";
import { ManagementError } from "#contract/errors.ts";
import type { PriceOverrideBody, PriceOverrideSaved } from "#contract/prices.ts";
import type { RoutingModels } from "#contract/routing.ts";
import { type ChunkOutcome, chunks, foldOutcomes } from "../lib/batch.ts";
import { causeMessage } from "../lib/failure.ts";
import type { SaveSettings, SettingsView } from "#contract/settings.ts";
import { HISTORY_SPAN_MS } from "../lib/history.ts";
import { orgSlugOfPath, scopedApiUrl } from "../lib/org.ts";
import { type RuleChange, type RuleWrite, saveRuleChange } from "../lib/models.ts";
import { type Edits, saveDraft } from "../lib/settings.ts";
import {
  type Breakdown,
  filterQuery,
  mergePoints,
  type RangeId,
  rangeOf,
  rangeStart,
  type UsageFilters,
} from "../lib/usage.ts";

/** The org this panel page shows, from its address (`/o/<slug>/...`); none on the org chooser. */
export const panelOrgSlug = orgSlugOfPath(window.location.pathname);

export class ManagementClient extends AtomHttpApi.Service<ManagementClient>()(
  "cf-llm-proxy/ManagementClient",
  {
    api: ManagementApi,
    httpClient: FetchHttpClient.layer,
    baseUrl: window.location.origin,
    // The pages call the routes of their org (`/v8/management/orgs/<slug>/...`); `/me` and `/orgs` are the platform's.
    transformClient: HttpClient.mapRequest(
      HttpClientRequest.updateUrl((url) => scopedApiUrl(url, panelOrgSlug)),
    ),
  },
) {}

/** How long a page's data stays cached after its last reader unmounts (switching pages does not refetch). */
const KEEP = Duration.minutes(5);

/** Every query that reads credentials refetches after a mutation tagged with this key. */
export const CREDENTIALS = ["credentials"] as const;

/** Reads that depend on the list of orgs refetch after a mutation tagged with this key. */
export const ORGS = ["orgs"] as const;

/**
 * Who the caller is, which orgs they belong to and their role in the org the panel shows (`GET /me`, addressed to
 * the org on an org's pages): the shell, the page gates and the org chooser read it.
 */
export const meAtom = ManagementClient.query("orgs", "me", {
  reactivityKeys: ORGS,
  timeToLive: KEEP,
});

/** Creates an org (platform admins; call with `reactivityKeys: ORGS`). */
export const createOrgAtom = ManagementClient.mutation("orgs", "create");

/** The Members page refetches after a mutation tagged with this key. */
export const MEMBERS = ["members"] as const;

/** The org's people with their roles and teams. */
export const membersAtom = ManagementClient.query("members", "list", {
  reactivityKeys: MEMBERS,
  timeToLive: KEEP,
});

export const teamsAtom = ManagementClient.query("members", "teams", {
  reactivityKeys: MEMBERS,
  timeToLive: KEEP,
});

export const serviceTokensAtom = ManagementClient.query("members", "serviceTokens", {
  reactivityKeys: MEMBERS,
  timeToLive: KEEP,
});

/** Whether anyone Access admits joins the org by themselves. */
export const membershipAtom = ManagementClient.query("members", "settings", {
  reactivityKeys: MEMBERS,
  timeToLive: KEEP,
});

// Member, team and service token writes: call with `reactivityKeys: MEMBERS` so the lists refetch afterwards.
export const addMemberAtom = ManagementClient.mutation("members", "add");

export const updateMemberAtom = ManagementClient.mutation("members", "update");

export const removeMemberAtom = ManagementClient.mutation("members", "remove");

export const updateMembershipAtom = ManagementClient.mutation("members", "updateSettings");

export const createTeamAtom = ManagementClient.mutation("members", "createTeam");

export const renameTeamAtom = ManagementClient.mutation("members", "renameTeam");

export const deleteTeamAtom = ManagementClient.mutation("members", "deleteTeam");

export const addTeamMemberAtom = ManagementClient.mutation("members", "addTeamMember");

export const removeTeamMemberAtom = ManagementClient.mutation("members", "removeTeamMember");

export const registerServiceTokenAtom = ManagementClient.mutation(
  "members",
  "registerServiceToken",
);

export const updateServiceTokenAtom = ManagementClient.mutation("members", "updateServiceToken");

export const removeServiceTokenAtom = ManagementClient.mutation("members", "removeServiceToken");

/** Every credential with its state (`GET /credentials`). */
export const credentialsAtom = ManagementClient.query("credentials", "list", {
  reactivityKeys: CREDENTIALS,
  timeToLive: KEEP,
});

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Bumped by the shell's Refresh button: the usage atoms read it, so they refetch (keeping their figures while they
 * load) and recompute their time range.
 */
export const usageEpochAtom = Atom.make(0).pipe(Atom.keepAlive);

/** Usage of the last 24 hours by model; the window is recomputed on every refresh. */
export const usageLastDayAtom = ManagementClient.runtime
  .atom((get) =>
    Effect.gen(function* () {
      get(usageEpochAtom);
      const client = yield* ManagementClient;
      const now = yield* Clock.currentTimeMillis;

      return yield* client.usage.summary({ query: { group_by: "model", since: now - DAY_MS } });
    }),
  )
  .pipe(Atom.setIdleTTL(KEEP));

/** What the Usage page shows: a range and filters (atom family keys compare structurally). */
export interface UsageView {
  readonly range: RangeId;
  readonly filters: UsageFilters;
}

/** Totals and one breakdown over a range. */
export const usageSummaryAtom = Atom.family(
  (key: { readonly view: UsageView; readonly by: Breakdown["id"] }) =>
    ManagementClient.runtime
      .atom((get) =>
        Effect.gen(function* () {
          get(usageEpochAtom);
          const client = yield* ManagementClient;
          const now = yield* Clock.currentTimeMillis;

          return yield* client.usage.summary({
            query: {
              group_by: key.by,
              since: rangeStart(rangeOf(key.view.range), now),
              ...filterQuery(key.view.filters),
            },
          });
        }),
      )
      .pipe(Atom.setIdleTTL(KEEP)),
);

/** Hourly points over a range, every series summed, with the time they were read at (the chart's "now"). */
export const usageSeriesAtom = Atom.family((view: UsageView) =>
  ManagementClient.runtime
    .atom((get) =>
      Effect.gen(function* () {
        get(usageEpochAtom);
        const client = yield* ManagementClient;
        const now = yield* Clock.currentTimeMillis;
        const { model, provider, auth_index, member } = filterQuery(view.filters);

        // The series has no principal filter: the page shows no chart while a user filter is set.
        const series = yield* client.usage.series({
          query: {
            since: rangeStart(rangeOf(view.range), now),
            bucket: "hour",
            group_by: "provider",
            ...(model === undefined ? {} : { model }),
            ...(provider === undefined ? {} : { provider }),
            ...(auth_index === undefined ? {} : { auth_index }),
            ...(member === undefined ? {} : { member }),
          },
        });

        return { now, points: mergePoints(series.series) };
      }),
    )
    .pipe(Atom.setIdleTTL(KEEP)),
);

/** The provider and model pairs with unpriced requests in a view, the busiest first (what to give a price override). */
export const usageUnpricedAtom = Atom.family((view: UsageView) =>
  ManagementClient.runtime
    .atom((get) =>
      Effect.gen(function* () {
        get(usageEpochAtom);
        const client = yield* ManagementClient;
        const now = yield* Clock.currentTimeMillis;

        return yield* client.usage.unpriced({
          query: { since: rangeStart(rangeOf(view.range), now), ...filterQuery(view.filters) },
        });
      }),
    )
    .pipe(Atom.setIdleTTL(KEEP)),
);

/** Records per page of the request log. */
export const LOG_PAGE_SIZE = 50;

/** One page of the request log, newest first; `before` is the previous page's `next_before`. */
export const usageRecordsAtom = Atom.family(
  (key: {
    readonly view: UsageView;
    readonly failedOnly: boolean;
    readonly before: string | undefined;
  }) =>
    ManagementClient.runtime
      .atom((get) =>
        Effect.gen(function* () {
          get(usageEpochAtom);
          const client = yield* ManagementClient;
          const now = yield* Clock.currentTimeMillis;

          return yield* client.usage.records({
            query: {
              since: rangeStart(rangeOf(key.view.range), now),
              limit: LOG_PAGE_SIZE,
              ...filterQuery(key.view.filters),
              ...(key.failedOnly ? { failed: "true" as const } : {}),
              ...(key.before === undefined ? {} : { before: key.before }),
            },
          });
        }),
      )
      .pipe(Atom.setIdleTTL(KEEP)),
);

/** One account's hourly usage over the history span (by `auth_index`), for its window history. */
export const accountSeriesAtom = Atom.family((authIndex: string) =>
  ManagementClient.runtime
    .atom(
      Effect.gen(function* () {
        const client = yield* ManagementClient;
        const now = yield* Clock.currentTimeMillis;
        const since = now - HISTORY_SPAN_MS;

        const series = yield* client.usage.series({
          query: { since, bucket: "hour", group_by: "auth", auth_index: authIndex },
        });

        return {
          since,
          points: series.series.find((entry) => entry.key === authIndex)?.points ?? [],
        };
      }),
    )
    .pipe(Atom.setIdleTTL(KEEP)),
);

/** The models one account can serve (credential name), read when the operator opens the list. */
export const accountModelsAtom = Atom.family((name: string) =>
  ManagementClient.query("credentials", "models", {
    query: { name },
    timeToLive: KEEP,
  }),
);

/** The API keys page refetches after a mutation tagged with this key. */
export const API_KEYS = ["api-keys"] as const;

/** Every configured API key group with its id, revision and its keys' state (writes name the group by both). */
export const apiKeysAtom = ManagementClient.query("apiKeys", "list", {
  reactivityKeys: API_KEYS,
  timeToLive: KEEP,
});

// Group writes: call with `reactivityKeys: API_KEYS`.
export const putKeyGroupAtom = ManagementClient.mutation("apiKeys", "putGroup");

export const deleteKeyGroupAtom = ManagementClient.mutation("apiKeys", "deleteGroup");

/**
 * One connection test per key (`auth_index`; call it with no argument). `mutation` atoms are shared per endpoint and
 * keep one call at a time, so keys tested together would read each other's answers.
 */
export const probeKeyAtom = Atom.family((authIndex: string) =>
  ManagementClient.runtime.fn(() =>
    Effect.gen(function* () {
      const client = yield* ManagementClient;

      return yield* client.apiKeys.probe({ payload: { auth_index: authIndex } });
    }),
  ),
);

/**
 * A write refused with 409 `conflict` means the view it was made from is stale: refetch every query tagged with
 * `keys` (the mutations invalidate only on success).
 */
const reloadOnConflict =
  (keys: ReadonlyArray<string>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.tapError(effect, (error) =>
      error instanceof ManagementError && error.error === "conflict"
        ? Reactivity.invalidate(keys)
        : Effect.void,
    );

/** The Models page refetches after a mutation tagged with this key. */
export const ROUTING = ["routing"] as const;

/** Every model clients can call with the credentials that serve it, and the channel rules (fresh on every read). */
export const routingModelsAtom = ManagementClient.query("routing", "models", {
  reactivityKeys: ROUTING,
  timeToLive: KEEP,
});

/** The catalog status refetches after a refresh tagged with this key. */
export const CATALOG = ["catalog"] as const;

/** Which model catalog is in use, where it comes from and when it was last refreshed. */
export const catalogStatusAtom = ManagementClient.query("catalog", "status", {
  reactivityKeys: CATALOG,
  timeToLive: KEEP,
});

/** Refreshes the catalog now (call with `reactivityKeys: [...CATALOG, ...ROUTING]`: the model list may change). */
export const refreshCatalogAtom = ManagementClient.mutation("catalog", "refresh");

/**
 * One channel rule edit (key: `<rule>:<channel>`), sent with the channel entry's revision (`view.revisions`) as
 * `If-Match` and re-applied to a fresh read once when another edit of that channel landed first (`saveRuleChange`); a
 * refusal that stays refetches the view. Transport and decoding failures become defects, as in the generated
 * mutations, so the failure is a `ManagementError` or none.
 */
export const saveRuleAtom = Atom.family((_key: string) =>
  ManagementClient.runtime.fn(
    (input: { readonly change: RuleChange; readonly base: RoutingModels }) =>
      Effect.gen(function* () {
        const client = yield* ManagementClient;

        const write = (request: RuleWrite, revision: number) => {
          const headers = { "if-match": String(revision) };
          const params = { channel: request.channel };

          switch (request.kind) {
            case "put-aliases":
              return client.routing.putAliases({ params, headers, payload: request.body });
            case "delete-aliases":
              return client.routing.deleteAliases({ params, headers });
            case "put-excluded":
              return client.routing.putExclusions({ params, headers, payload: request.body });
            case "delete-excluded":
              return client.routing.deleteExclusions({ params, headers });
          }
        };

        return yield* Reactivity.mutation(
          saveRuleChange(input.change, input.base, { read: client.routing.models(), write }),
          ROUTING,
        ).pipe(reloadOnConflict(ROUTING));
      }).pipe(
        Effect.catchIf(
          (error) => Schema.isSchemaError(error) || HttpClientError.isHttpClientError(error),
          Effect.die,
        ),
      ),
  ),
);

/** The Prices page refetches after a mutation tagged with this key. */
export const PRICES = ["prices"] as const;

/** The org's price overrides with the revision of each (writes send it back). */
export const priceOverridesAtom = ManagementClient.query("prices", "list", {
  reactivityKeys: PRICES,
  timeToLive: KEEP,
});

/** One price override write: add, replace (with the override's revision as `If-Match`) or remove. */
export type PriceWrite =
  | { readonly kind: "create"; readonly body: PriceOverrideBody }
  | {
      readonly kind: "replace";
      readonly id: string;
      readonly revision: number;
      readonly body: PriceOverrideBody;
    }
  | { readonly kind: "remove"; readonly id: string; readonly revision: number };

/**
 * A price write; the list refetches afterwards, also after a refusal that stays (409: another edit landed first).
 * Transport and decoding failures become defects, as in the generated mutations, so the failure is a
 * `ManagementError` or none.
 */
export const savePriceAtom = ManagementClient.runtime.fn((write: PriceWrite) =>
  Effect.gen(function* () {
    const client = yield* ManagementClient;

    const call = (): Effect.Effect<
      PriceOverrideSaved,
      ManagementError | Schema.SchemaError | HttpClientError.HttpClientError
    > => {
      switch (write.kind) {
        case "create":
          return client.prices.create({ payload: write.body });
        case "replace":
          return client.prices.replace({
            params: { id: write.id },
            headers: { "if-match": String(write.revision) },
            payload: write.body,
          });
        case "remove":
          return client.prices.remove({
            params: { id: write.id },
            headers: { "if-match": String(write.revision) },
          });
      }
    };

    return yield* Reactivity.mutation(call(), PRICES).pipe(reloadOnConflict(PRICES));
  }).pipe(
    Effect.catchIf(
      (error) => Schema.isSchemaError(error) || HttpClientError.isHttpClientError(error),
      Effect.die,
    ),
  ),
);

/** The Settings page refetches after a mutation tagged with this key. */
export const SETTINGS = ["settings"] as const;

/** The settings that apply on Workers, their defaults and the revision of each stored setting (writes send them back). */
export const settingsAtom = ManagementClient.query("settings", "get", {
  reactivityKeys: SETTINGS,
  timeToLive: KEEP,
});

/** How the settings saves read the view and write a patch. */
const settingsIo = (client: ManagementClient["Service"]) => ({
  read: client.settings.get(),
  write: (save: SaveSettings) => client.settings.save({ payload: save }),
});

/**
 * One section's save (key: the section), sent with the revision of each setting it changes and re-applied once to a
 * fresh read on 409 (`saveDraft`). The view refetches afterwards (also after a refusal that stays), so the other
 * sections rebase onto it. Transport and decoding failures become defects, as in the generated mutations, so the
 * failure is a `ManagementError` or none.
 */
export const saveSettingsAtom = Atom.family((_section: string) =>
  ManagementClient.runtime.fn((input: { readonly edits: Edits; readonly base: SettingsView }) =>
    Effect.gen(function* () {
      const io = settingsIo(yield* ManagementClient);

      return yield* Reactivity.mutation(saveDraft(input.edits, input.base, io), SETTINGS).pipe(
        reloadOnConflict(SETTINGS),
      );
    }).pipe(
      Effect.catchIf(
        (error) => Schema.isSchemaError(error) || HttpClientError.isHttpClientError(error),
        Effect.die,
      ),
    ),
  ),
);

// Mutations: call with `reactivityKeys: CREDENTIALS` so the credential list refetches afterwards (`API_KEYS` for a
// config API key).
export const setDisabledAtom = ManagementClient.mutation("credentials", "setDisabled");

export const patchFieldsAtom = ManagementClient.mutation("credentials", "patchFields");

export const refreshAtom = ManagementClient.mutation("credentials", "refresh");

export const resetCooldownAtom = ManagementClient.mutation("credentials", "resetCooldown");

export const removeAtom = ManagementClient.mutation("credentials", "remove");

export const uploadAtom = ManagementClient.mutation("credentials", "upload");

export const checkQuotaAtom = ManagementClient.mutation("credentials", "checkQuota");

/** Checks every enabled account's quota now (call with `reactivityKeys: CREDENTIALS`). */
export const checkAllQuotasAtom = ManagementClient.mutation("credentials", "checkAllQuotas");

/**
 * One batch action over the selected accounts (file names), sent in requests of at most `batchLimit(action)`, one after
 * another, and folded into who succeeded and who failed and why (`foldOutcomes`). A request that fails as a whole
 * fails its accounts with the reason instead of failing the action, so the others' outcomes still show. The credential
 * list refetches afterwards.
 */
export const batchAtom = ManagementClient.runtime.fn(
  (input: { readonly action: BatchAction; readonly names: ReadonlyArray<string> }) =>
    Effect.gen(function* () {
      const client = yield* ManagementClient;

      const outcomes = yield* Effect.forEach(
        chunks(input.names, batchLimit(input.action)),
        (names) =>
          client.credentials.batch({ payload: { action: input.action, names } }).pipe(
            Effect.map((answer): ChunkOutcome => ({ names, results: answer.results })),
            Effect.catch((error) =>
              Effect.succeed<ChunkOutcome>({ names, failure: causeMessage(Cause.fail(error)) }),
            ),
          ),
      );

      return foldOutcomes(outcomes);
    }).pipe((effect) => Reactivity.mutation(effect, CREDENTIALS)),
);

/** Reads a Claude account's reset grants from Anthropic now (stored server-side: refresh `CREDENTIALS` after it). */
export const readResetGrantsAtom = ManagementClient.mutation("credentials", "resetGrants");

/** Spends one reset of a Claude account; the server picks the grant and re-checks first. */
export const claimResetGrantAtom = ManagementClient.mutation("credentials", "claimResetGrant");

export const oauthStartAtom = ManagementClient.mutation("oauth", "start");

export const oauthStatusAtom = ManagementClient.mutation("oauth", "status");

export const oauthCancelAtom = ManagementClient.mutation("oauth", "cancel");

export const oauthCallbackAtom = ManagementClient.mutation("oauth", "callback");

/** The current time, ticking every 30 seconds while something reads it ("resets in" countdowns). */
export const nowAtom = Atom.make((get) => {
  const timer = setInterval(() => get.setSelf(Date.now()), 30_000);
  get.addFinalizer(() => clearInterval(timer));

  return Date.now();
});
