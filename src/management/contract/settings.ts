/**
 * `GET|PATCH /v8/management/settings` (`../settings-routes.ts`, `../settings.ts`): the Settings page's typed view of
 * the config settings that apply on Workers, and its writes; `GET|PUT /settings/config` and
 * `POST /settings/config/check` (`../settings-raw-routes.ts`, `../config-secrets.ts`): the raw configuration editor.
 * Shared with the browser: imports `effect` and sibling contract modules only.
 *
 * Values keep the config's kebab-case spelling and nesting, so a patch maps 1:1 to document paths. The view never
 * carries a secret (PRODUCT.md): API keys have their own page, and the keys that do nothing on Workers are listed by
 * name and reason only (`not_applied`; proxy URLs and client keys may be credentials).
 *
 * A save is `{version, patch}`: `patch` is a deep partial of {@link SettingsValues} where `null` resets a leaf to its
 * default (removes it from the document); the not-applied keys accept `null` only (remove them). Answers: the new
 * `version`; `409 conflict` when `version` is stale (no retry: re-read and re-apply); `400 not_a_setting` for a path
 * that is not a setting; `422 invalid_setting` with `message` and `path` for a value the config would not keep as sent
 * (invalid duration, unknown catalog source, a value the normaliser rewrites, ...); `422
 * would_remove_your_admin_access` when a caller who is not a deployment admin removes themselves from the config's
 * admin lists.
 *
 * The raw configuration is the whole document as YAML without defaults, every secret masked as `[redacted#n]…abcd`
 * (`secrets` counts them; the panel never reads `GET /config*`, which serve raw secrets to the upstream panel).
 * Comments and key order are not kept, anchors are expanded and custom tags refused: only the canonical document is
 * stored. `checkRaw` and `saveRaw` take `{version, yaml}`; a placeholder left as it was keeps its stored secret, plain
 * text at a secret position is a new secret. Both answer `409 conflict` for a stale `version` (placeholders are bound
 * to it); `422 invalid_yaml` with `message`, `line`, `column`; `422 invalid_config` with `message` and `path` when
 * known; `422 masked_value_outside_secret_field` / `unknown_secret_reference` / `invalid_secret_placeholder` with
 * the `path` of a placeholder that cannot be restored; `422 would_remove_your_admin_access`; `413` above 512 KiB.
 * `checkRaw` stores nothing and returns the masked canonical result (new secrets as `[new secret]…abcd`, told apart
 * from kept ones by origin, never by value) and `moved_secrets`, each kept secret now sent to another provider family
 * or upstream address with its placeholder, path and the family and host before and after (host only: user info,
 * path and query can carry secrets; also in the `saveRaw` reply). `saveRaw` of a document whose canonical form equals
 * the stored one writes nothing and returns the same `version`.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { RequestScopedErrorRule } from "./api-keys.ts";
import { ConfigVersion, Saved } from "./config.ts";
import { managementErrors } from "./errors.ts";

const optional = Schema.optionalKey;

const Strings = Schema.Array(Schema.String);

/** `routing.strategy` (the aliases `wrr`, `ff`, ... are normalised when a document is imported). */
export const RoutingStrategy = Schema.Literals([
  "round-robin",
  "weighted-round-robin",
  "fill-first",
]);

export type RoutingStrategy = typeof RoutingStrategy.Type;

/** `multimedia.disable-image-generation`: `false`, `true`, `"chat"` or `"passthrough"`. */
export const DisableImageGeneration = Schema.Union([
  Schema.Boolean,
  Schema.Literals(["chat", "passthrough"]),
]);

export type DisableImageGeneration = typeof DisableImageGeneration.Type;

/** A Go duration (`30m`, `1h30m`); validated by the server. */
const GoDuration = Schema.String;

/** A Go `*bool`: `null` = not set (the setting's documented default applies). */
const Tristate = Schema.NullOr(Schema.Boolean);

/** Nested sections whose leaves are schemas: one definition for the values and the patch. */
interface SettingsTree {
  readonly [key: string]: Schema.Top | SettingsTree;
}

/**
 * Every Settings-owned config key. Sections are plain objects, leaves are schemas. Not here: `api-keys` (Keys page),
 * `oauth.model-alias` / `excluded-models` (Models › Rules), `oauth.settings`, `requests.payload` and
 * `oauth.request-scoped-errors` (raw configuration; the view summarises the last two), and the keys that do nothing
 * on Workers.
 */
export const SETTINGS_TREE = {
  routing: {
    strategy: RoutingStrategy,
    "session-affinity": Schema.Boolean,
    "session-affinity-ttl": GoDuration,
    "session-affinity-subagents": Schema.Boolean,
    "force-model-prefix": Schema.Boolean,
    retry: {
      "request-retry": Schema.Int,
      /** 0 = every credential. */
      "max-retry-credentials": Schema.Int,
      /** Seconds; the Worker waits at most 30 s and answers `Retry-After` beyond that. */
      "max-retry-interval": Schema.Int,
    },
    cooldown: {
      "disable-cooling": Schema.Boolean,
      /** Kept in the ControlPlane Durable Object on Workers. */
      "save-cooldown-status": Schema.Boolean,
      /** 0 = 60 s, negative disables. */
      "transient-error-cooldown-seconds": Schema.Int,
    },
  },
  requests: {
    "passthrough-headers": Schema.Boolean,
    "nonstream-keepalive-interval": Schema.Int,
    streaming: {
      /** Server-sent events only (no WebSocket pings on Workers). */
      "keepalive-seconds": Schema.Int,
      "bootstrap-retries": Schema.Int,
    },
  },
  upstream: {
    codex: {
      "response-steering": Schema.Boolean,
      "disable-codex-cloaking": Schema.Boolean,
      "stream-bootstrap-buffering": Schema.Boolean,
      /** Go duration or whole seconds; `0`, `none`, `unlimited`, `off`, ... = unlimited. */
      "stream-bootstrap-timeout": Schema.String,
      "orphan-delegation-compatibility": Schema.Boolean,
      "model-level-cooling": Schema.Boolean,
    },
    claude: {
      "model-level-cooling": Schema.Boolean,
      "disable-claude-cloak-mode": Schema.Boolean,
      "disable-cloaking-model-list": Schema.Boolean,
      "header-defaults": {
        "user-agent": Schema.String,
        "package-version": Schema.String,
        "runtime-version": Schema.String,
        os: Schema.String,
        arch: Schema.String,
        timeout: Schema.String,
        /** IANA time zone, `Local` or empty (UTC). */
        timezone: Schema.String,
        "stabilize-device-profile": Tristate,
      },
    },
    xai: { "inject-x-search": Schema.Boolean },
  },
  client: {
    codex: {
      "enable-apply-patch": Schema.Boolean,
      "optimize-multi-agent-v2": Schema.Boolean,
    },
  },
  oauth: {
    /** Token refresh concurrency per run; 0 = 16. */
    "auth-auto-refresh-workers": Schema.Int,
    providers: {
      codex: {
        "header-defaults": { "user-agent": Schema.String, "beta-features": Schema.String },
      },
      antigravity: {
        "sensitive-words": Strings,
        "antigravity-credits": Schema.Boolean,
        /** `null` = on. */
        "signature-cache-enabled": Tristate,
        /** `null` = off. */
        "signature-bypass-strict": Tristate,
      },
      devin: { "sensitive-words": Strings },
    },
  },
  multimedia: {
    "disable-image-generation": DisableImageGeneration,
    /** Empty = `gpt-5.4-mini`; must start with `gpt-`. */
    "gpt-image-2-base-model": Schema.String,
    "video-result-auth-cache-ttl": GoDuration,
  },
  models: {
    /** `""` official source, `embed`, `disabled` or an http(s) URL. */
    catalog: Schema.String,
    "codex-catalog": Schema.String,
    "devin-catalog": Schema.String,
  },
  access: {
    /** Extend `ACCESS_ADMIN_EMAILS` (lower-case). */
    "admin-emails": Strings,
    /** Extend `ACCESS_ADMIN_SERVICE_TOKENS` (Access service token client ids). */
    "admin-service-tokens": Strings,
  },
} as const satisfies SettingsTree;

type ValuesFields<T extends SettingsTree> = {
  readonly [K in keyof T]: T[K] extends infer Leaf extends Schema.Top
    ? Leaf
    : T[K] extends infer Section extends SettingsTree
      ? Schema.Struct<ValuesFields<Section>>
      : never;
};

type PatchFields<T extends SettingsTree> = {
  readonly [K in keyof T]: T[K] extends infer Leaf extends Schema.Top
    ? Schema.optionalKey<Schema.NullOr<Leaf>>
    : T[K] extends infer Section extends SettingsTree
      ? Schema.optionalKey<Schema.Struct<PatchFields<Section>>>
      : never;
};

const mapTree = (
  tree: SettingsTree,
  leaf: (schema: Schema.Top) => Schema.Top,
  section: (fields: Schema.Struct.Fields) => Schema.Top,
): Schema.Struct.Fields =>
  Object.fromEntries(
    Object.entries(tree).map(([key, node]) => [
      key,
      Schema.isSchema(node) ? leaf(node) : section(mapTree(node, leaf, section)),
    ]),
  );

const valuesFields = <T extends SettingsTree>(tree: T): ValuesFields<T> =>
  // SAFETY: mapTree keeps every key of `tree`, leaves as they are and sections as structs: the shape of ValuesFields.
  mapTree(
    tree,
    (schema) => schema,
    (fields) => Schema.Struct(fields),
  ) as ValuesFields<T>;

const patchFields = <T extends SettingsTree>(tree: T): PatchFields<T> =>
  // SAFETY: mapTree keeps every key of `tree`, leaves as optional nullable and sections as optional structs.
  mapTree(
    tree,
    (schema) => optional(Schema.NullOr(schema)),
    (fields) => optional(Schema.Struct(fields)),
  ) as PatchFields<T>;

/** Every Settings-owned value, effective (defaults filled), in config spelling. */
export const SettingsValues = Schema.Struct(valuesFields(SETTINGS_TREE));

export type SettingsValues = typeof SettingsValues.Type;

/** A not-applied key: the patch may only remove it. */
const removeOnly = optional(Schema.Null);

/**
 * Deep partial of {@link SettingsValues}; `null` resets a leaf to its default. The keys listed in the view's
 * `not_applied` that have a mapping path accept `null` only (remove them).
 */
export const SettingsPatch = Schema.Struct({
  ...patchFields(SETTINGS_TREE),
  requests: optional(
    Schema.Struct({ ...patchFields(SETTINGS_TREE.requests), "proxy-url": removeOnly }),
  ),
  access: optional(Schema.Struct({ ...patchFields(SETTINGS_TREE.access), "api-keys": removeOnly })),
  observability: optional(
    Schema.Struct({
      logs: optional(Schema.Struct({ debug: removeOnly, "request-log": removeOnly })),
      usage: optional(
        Schema.Struct({
          "usage-statistics-enabled": removeOnly,
          "redis-usage-queue-retention-seconds": removeOnly,
        }),
      ),
    }),
  ),
});

export type SettingsPatch = typeof SettingsPatch.Type;

/** A config key that has no effect on Workers and is set: its name and why (never its value). */
export const NotApplied = Schema.Struct({ key: Schema.String, reason: Schema.String });

export const PayloadCounts = Schema.Struct({
  default: Schema.Int,
  "default-raw": Schema.Int,
  override: Schema.Int,
  "override-raw": Schema.Int,
  filter: Schema.Int,
});

export const SettingsView = Schema.Struct({
  version: ConfigVersion,
  /** ISO time of the last config write; absent when nothing was ever stored. */
  updated_at: optional(Schema.String),
  values: SettingsValues,
  /** The values of an empty config: "default" captions and Reset. */
  defaults: SettingsValues,
  not_applied: Schema.Array(NotApplied),
  /** `ACCESS_ADMIN_EMAILS` / `ACCESS_ADMIN_SERVICE_TOKENS`: always admins, not editable here. */
  env_admins: Schema.Struct({ emails: Strings, service_tokens: Strings }),
  /** `requests.payload` rule counts per kind (edited in the raw configuration). */
  payload: PayloadCounts,
  /** Accounts and API keys with a model prefix (what `routing.force-model-prefix` acts on). */
  prefixed_credentials: Schema.Int,
  /** `oauth.request-scoped-errors`: per account provider, read-only here (edited in the raw configuration). */
  request_scoped_errors: Schema.Record(Schema.String, Schema.Array(RequestScopedErrorRule)),
});

export type SettingsView = typeof SettingsView.Type;

export const SaveSettings = Schema.Struct({ version: ConfigVersion, patch: SettingsPatch });

export type SaveSettings = typeof SaveSettings.Type;

/** `GET /settings/config`: the stored document as sparse YAML with every secret masked. */
export const RawConfig = Schema.Struct({
  version: ConfigVersion,
  yaml: Schema.String,
  /** How many `[redacted#n]` placeholders `yaml` carries (n = 1..secrets). */
  secrets: Schema.Int,
});

export type RawConfig = typeof RawConfig.Type;

/** An edited raw configuration and the `version` it was read at. */
export const RawConfigInput = Schema.Struct({ version: ConfigVersion, yaml: Schema.String });

export type RawConfigInput = typeof RawConfigInput.Type;

/** Where a secret is sent: provider family (or config section) and upstream host, never the rest of the URL. */
export const SecretPlace = Schema.Struct({ family: Schema.String, host: optional(Schema.String) });

export type SecretPlace = typeof SecretPlace.Type;

/** A kept secret now sent to another provider family or upstream host than where it was stored. */
export const MovedSecret = Schema.Struct({
  path: Schema.String,
  /** `[redacted#n]…abcd`, as the review's `yaml` shows it. */
  placeholder: Schema.String,
  from: SecretPlace,
  to: SecretPlace,
});

export type MovedSecret = typeof MovedSecret.Type;

/** What a save would store, for the review (nothing is stored). */
export const RawConfigCheck = Schema.Struct({
  /** The canonical result as sparse YAML, masked: kept secrets `[redacted#n]…`, new ones `[new secret]…`. */
  yaml: Schema.String,
  /** Paths of the input that would not be stored as written (unknown or Workers-only keys, entries the normaliser
   * removes or rewrites). */
  dropped: Strings,
  /** Keys set in the result that have no effect on Workers. */
  not_applied: Strings,
  kept_secrets: Schema.Int,
  new_secrets: Schema.Int,
  /** Kept secrets now sent to another provider family or upstream address than where they were stored. */
  moved_secrets: Schema.Array(MovedSecret),
});

export type RawConfigCheck = typeof RawConfigCheck.Type;

/** A stored raw configuration; `version` is unchanged when the document was already stored as is. */
export const RawConfigSaved = Schema.Struct({
  status: Schema.Literal("ok"),
  version: Schema.Int,
  dropped: Strings,
  not_applied: Strings,
  moved_secrets: Schema.Array(MovedSecret),
});

export type RawConfigSaved = typeof RawConfigSaved.Type;

export class SettingsGroup extends HttpApiGroup.make("settings").add(
  HttpApiEndpoint.get("get", "/settings", { success: SettingsView, error: managementErrors }),
  HttpApiEndpoint.patch("save", "/settings", {
    payload: SaveSettings,
    success: Saved,
    error: managementErrors,
  }),
  HttpApiEndpoint.get("raw", "/settings/config", { success: RawConfig, error: managementErrors }),
  HttpApiEndpoint.post("checkRaw", "/settings/config/check", {
    payload: RawConfigInput,
    success: RawConfigCheck,
    error: managementErrors,
  }),
  HttpApiEndpoint.put("saveRaw", "/settings/config", {
    payload: RawConfigInput,
    success: RawConfigSaved,
    error: managementErrors,
  }),
) {}
