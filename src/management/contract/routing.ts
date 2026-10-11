/**
 * `GET /v8/management/routing/models` (`../routing-models.ts`, `src/registry/routing-view.ts`) and the channel rule
 * edits of the Models page (`PUT|DELETE /config/oauth/model-alias/:channel`, `/config/oauth/excluded-models/:channel`,
 * served by `../config-routes.ts`). Shared with the browser: imports `effect` only.
 *
 * `routing/models` answers, per client-visible model id, every credential that could serve it and why it does or does
 * not right now. It is built from a fresh (uncached) registry snapshot, so an edit shows on the next read. The same
 * body carries the two rule maps and `config_version`: a rule edit sends it back as `If-Match` and the write is
 * refused with 409 `conflict` when the config changed since (arrays are replaced whole, so a stale view would
 * otherwise lose another tab's edit). The new version comes back in `Saved.version`.
 *
 * Concepts. A *channel* is the credential's provider key as stored (lower-case auth-file `type`, e.g. `claude`,
 * `kimi.com`): the key of `oauth.model-alias` and `oauth.excluded-models`; API keys and OpenAI-compatible groups have
 * none. A *route* is one credential's way to one model id. `upstream` is the name the provider sees (the id before
 * aliasing and prefixing).
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { managementErrors } from "./errors.ts";

const optional = Schema.optionalKey;

/**
 * What one credential does for one model right now: `available`; `cooling` (retry timer, `until`); `quota`
 * (exceeded, `until` when the recovery time is known); `unavailable` (blocked without a timer, e.g. model disabled
 * upstream); `disabled` (the credential is switched off); `excluded` (an exclusion rule removes the model for this
 * credential, `reason` = the matching pattern).
 */
export const RouteState = Schema.Literals([
  "available",
  "cooling",
  "quota",
  "unavailable",
  "disabled",
  "excluded",
]);

export type RouteState = typeof RouteState.Type;

/** Where a model comes from: the provider catalog, the credential's configured `models` list, or an alias rule. */
export const RouteOrigin = Schema.Literals(["catalog", "config", "alias"]);

export type RouteOrigin = typeof RouteOrigin.Type;

/** Which rule list a `rule_scope` points at: the channel's global list, one account's file, one API key (group). */
export const RuleScope = Schema.Literals(["channel", "account", "key"]);

export type RuleScope = typeof RuleScope.Type;

export const ModelRoute = Schema.Struct({
  /** Credential handle (`credentials.list` entries carry the same value). */
  auth_index: Schema.String,
  source: Schema.Literals(["file", "config"]),
  /** Credential provider as stored; equals `channel` for accounts. */
  provider: Schema.String,
  /** Alias/exclusion channel; absent for API keys and OpenAI-compatible groups. */
  channel: optional(Schema.String),
  /** Account email, compat group name or `<family>-apikey`. */
  label: Schema.String,
  /** Auth-file name (file credentials only): the account page address. */
  name: optional(Schema.String),
  /** Upstream model name (before aliasing and prefixing). */
  upstream: Schema.String,
  via: RouteOrigin,
  /** Set when the client-visible id is `<prefix>/<model>`. */
  prefix: optional(Schema.String),
  state: RouteState,
  /** Cooldown reason, or the exclusion pattern that matched (`state: "excluded"`). */
  reason: optional(Schema.String),
  /** Excluded rows: where the matching pattern lives. Alias rows: where the alias rule lives. */
  rule_scope: optional(RuleScope),
  /** ISO time the cooldown or quota block ends (`cooling`, `quota`). */
  until: optional(Schema.String),
});

export type ModelRoute = typeof ModelRoute.Type;

export const RoutedModel = Schema.Struct({
  /** The id clients send. */
  id: Schema.String,
  display_name: optional(Schema.String),
  owned_by: Schema.String,
  type: Schema.String,
  /** Whether `/v1/models` lists it right now. */
  listed: Schema.Boolean,
  /** Registry providers (executor keys) with a serving credential, most registrations first. */
  providers: Schema.Array(Schema.String),
  context_length: optional(Schema.Number),
  routes: Schema.Array(ModelRoute),
});

export type RoutedModel = typeof RoutedModel.Type;

/** One `oauth.model-alias` entry (the config's wire keys). */
export const OAuthModelAliasWire = Schema.Struct({
  /** Upstream model name. */
  name: Schema.String,
  /** The id clients call instead. */
  alias: Schema.String,
  /** Keep the original id next to the alias. */
  fork: optional(Schema.Boolean),
  "display-name": optional(Schema.String),
  "force-mapping": optional(Schema.Boolean),
});

export type OAuthModelAliasWire = typeof OAuthModelAliasWire.Type;

export const RoutingChannel = Schema.Struct({
  channel: Schema.String,
  /** Credentials (enabled or not) using the channel. */
  accounts: Schema.Number,
});

export const RoutingModels = Schema.Struct({
  observed_at: Schema.String,
  /** Config version this view was built from; send it as `If-Match` on rule edits. */
  config_version: Schema.Number,
  /** `routing.force-model-prefix`: prefixed credentials serve only `<prefix>/<model>`. */
  force_model_prefix: Schema.Boolean,
  /** Channels with at least one credential, by name. */
  channels: Schema.Array(RoutingChannel),
  /** `oauth.model-alias`: channel to aliases. */
  aliases: Schema.Record(Schema.String, Schema.Array(OAuthModelAliasWire)),
  /** `oauth.excluded-models`: channel to patterns (`*` wildcards, matched on the upstream name). */
  excluded: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  /** Every model any credential could serve, sorted by id. */
  models: Schema.Array(RoutedModel),
});

export type RoutingModels = typeof RoutingModels.Type;

/** A saved config edit: `version` is the new config version. */
export const Saved = Schema.Struct({ status: Schema.Literal("ok"), version: Schema.Number });

export type Saved = typeof Saved.Type;

/** The `If-Match` request header: the `config_version` the edit was based on (a bare number or `"<number>"`). */
const IfMatch = { headers: Schema.Struct({ "if-match": Schema.String }) };

const channelParam = { params: { channel: Schema.String } };

export class RoutingGroup extends HttpApiGroup.make("routing").add(
  HttpApiEndpoint.get("models", "/routing/models", {
    success: RoutingModels,
    error: managementErrors,
  }),
  /** Replace one channel's aliases. */
  HttpApiEndpoint.put("putAliases", "/config/oauth/model-alias/:channel", {
    ...channelParam,
    ...IfMatch,
    payload: Schema.Array(OAuthModelAliasWire),
    success: Saved,
    error: managementErrors,
  }),
  /** Remove one channel's aliases (404 when it has none). */
  HttpApiEndpoint.delete("deleteAliases", "/config/oauth/model-alias/:channel", {
    ...channelParam,
    ...IfMatch,
    success: Saved,
    error: managementErrors,
  }),
  /** Replace one channel's exclusion patterns. */
  HttpApiEndpoint.put("putExclusions", "/config/oauth/excluded-models/:channel", {
    ...channelParam,
    ...IfMatch,
    payload: Schema.Array(Schema.String),
    success: Saved,
    error: managementErrors,
  }),
  /** Remove one channel's exclusion patterns (404 when it has none). */
  HttpApiEndpoint.delete("deleteExclusions", "/config/oauth/excluded-models/:channel", {
    ...channelParam,
    ...IfMatch,
    success: Saved,
    error: managementErrors,
  }),
) {}
