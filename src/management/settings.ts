/**
 * The Settings page's view of the config and its typed writes (pure; served by `settings-routes.ts`, contract
 * `contract/settings.ts`).
 *
 * Workers addition, no Go counterpart (Go v8 edits the YAML node tree through `/config`). The owned keys are
 * `SETTINGS_TREE`; a write is a deep partial of it where `null` removes the key from the document (back to its
 * default). Values the config would silently rewrite or ignore (invalid durations, unknown strategies, a
 * `gpt-image-2-base-model` without `gpt-`, negative counts, untrimmed text) are refused with their path instead: first
 * by `validateSettings`, then by the survival check, which decodes the edited document like the ControlPlane will and
 * compares every written leaf with the normalised result. The not-applied keys (`config/not-applied.ts`) that have a
 * mapping path accept `null` only, so the page can remove them; their values never appear in the view.
 */
import { Result, Schema } from "effect";
import { type AdminLists, configAdminLists, isAdmin } from "../access/config.ts";
import type { Principal } from "../access/principal.ts";
import { parseGoDuration } from "../config/accessors.ts";
import { encodeConfig } from "../config/codec.ts";
import { notAppliedRules, NOT_APPLIED_RULES } from "../config/not-applied.ts";
import { Config } from "../config/schema.ts";
import { isJsonObject, type Json, type JsonObject, jsonEquals } from "../json/index.ts";
import { deleteAtPath, getAtPath, writeAtPath } from "./config-document.ts";
import {
  SETTINGS_TREE,
  type SettingsValues as SettingsValuesType,
  SettingsValues,
  type SettingsView,
} from "./contract/settings.ts";

/** A refused write: the reply's status and `{error, message, path}`. */
export interface SettingsProblem {
  readonly status: 400 | 403 | 422;
  readonly error:
    | "not_a_setting"
    | "invalid_setting"
    | "would_remove_your_admin_access"
    | "service_tokens_require_service_admin";
  readonly message: string;
  /** Dotted config path. */
  readonly path: string;
}

/** One leaf write of a patch: `null` removes the key (default). */
export interface SettingsEdit {
  readonly path: ReadonlyArray<string>;
  readonly value: Json;
}

type PatchNode =
  | { readonly kind: "leaf"; readonly schema: Schema.Top }
  | { readonly kind: "remove" }
  | { readonly kind: "section"; readonly children: ReadonlyMap<string, PatchNode> };

interface Tree {
  readonly [key: string]: Schema.Top | Tree;
}

const sectionOf = (tree: Tree): Map<string, PatchNode> =>
  new Map(
    Object.entries(tree).map(([key, node]): [string, PatchNode] => [
      key,
      Schema.isSchema(node)
        ? { kind: "leaf", schema: node }
        : { kind: "section", children: sectionOf(node) },
    ]),
  );

/** Adds a remove-only leaf at `path` (creating sections; an owned leaf is never replaced). */
const addRemovable = (root: Map<string, PatchNode>, path: ReadonlyArray<string>): void => {
  const [head, ...rest] = path;

  if (head === undefined) return;
  const existing = root.get(head);

  if (rest.length === 0) {
    if (existing === undefined) root.set(head, { kind: "remove" });

    return;
  }

  if (existing !== undefined && existing.kind !== "section") return;
  const children = new Map(existing?.children);

  addRemovable(children, rest);
  root.set(head, { kind: "section", children });
};

/** What a patch may address: the owned settings plus the removable not-applied keys. */
const PATCH_ROOT: ReadonlyMap<string, PatchNode> = (() => {
  const root = sectionOf(SETTINGS_TREE);

  for (const rule of NOT_APPLIED_RULES) if (rule.path !== undefined) addRemovable(root, rule.path);

  return root;
})();

const dotted = (path: ReadonlyArray<string>): string => path.join(".");

const problem = (
  status: SettingsProblem["status"],
  error: SettingsProblem["error"],
  path: ReadonlyArray<string>,
  message: string,
): SettingsProblem => ({ status, error, path: dotted(path), message });

const invalid = (path: ReadonlyArray<string>, message: string) =>
  problem(422, "invalid_setting", path, message);

// --- value rules ---------------------------------------------------------------------------------------------------

const BOOTSTRAP_UNLIMITED = new Set(["", "0", "none", "unlimited", "disabled", "off", "never"]);

const isPositiveDuration = (text: string): boolean => {
  const parsed = parseGoDuration(text);

  return parsed !== undefined && parsed > 0;
};

const isTimezone = (zone: string): boolean => {
  if (zone === "" || zone === "Local") return true;

  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone !== "";
  } catch {
    return false;
  }
};

const isHttpUrl = (text: string): boolean => {
  try {
    const url = new URL(text);

    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
  } catch {
    return false;
  }
};

const isCatalogSource = (text: string): boolean =>
  text === "" || text === "embed" || text === "disabled" || isHttpUrl(text);

const NON_NEGATIVE = new Set([
  "routing.retry.request-retry",
  "routing.retry.max-retry-credentials",
  "routing.retry.max-retry-interval",
  "requests.nonstream-keepalive-interval",
  "requests.streaming.keepalive-seconds",
  "requests.streaming.bootstrap-retries",
  "oauth.auth-auto-refresh-workers",
]);

const DURATIONS = new Set([
  "routing.session-affinity-ttl",
  "multimedia.video-result-auth-cache-ttl",
]);

const CATALOGS = new Set(["models.catalog", "models.codex-catalog", "models.devin-catalog"]);

/** A value as a message names it: “EST” (the panel shows the message under the field, beside its hint). */
const quoted = (value: Json): string =>
  `“${typeof value === "string" ? value : JSON.stringify(value)}”`;

/**
 * A message when a typed value is not what Workers would apply as written (the semantic rules of each key). It names
 * the value and what it is not; the field's hint already says what is expected.
 */
const valueRule = (key: string, value: Json): string | undefined => {
  if (NON_NEGATIVE.has(key))
    return typeof value === "number" && value < 0 ? `${quoted(value)} is below 0` : undefined;

  if (typeof value === "string" && DURATIONS.has(key))
    return isPositiveDuration(value)
      ? undefined
      : `${quoted(value)} is not a duration greater than zero`;

  if (typeof value === "string" && CATALOGS.has(key))
    return isCatalogSource(value)
      ? undefined
      : `${quoted(value)} is not embed, disabled or an http(s) URL`;

  if (typeof value === "string" && key === "upstream.codex.stream-bootstrap-timeout") {
    const ok =
      BOOTSTRAP_UNLIMITED.has(value.toLowerCase()) ||
      (parseGoDuration(value) ?? -1) >= 0 ||
      /^\d+$/.test(value);

    return ok ? undefined : `${quoted(value)} is not a duration or whole seconds`;
  }

  if (typeof value === "string" && key === "multimedia.gpt-image-2-base-model")
    return value === "" || value.toLowerCase().startsWith("gpt-")
      ? undefined
      : `${quoted(value)} does not start with gpt-`;

  if (typeof value === "string" && key === "upstream.claude.header-defaults.timezone")
    return isTimezone(value) ? undefined : `${quoted(value)} is not an IANA time zone`;

  if (Array.isArray(value) && key === "access.admin-emails") {
    const bad = value.find(
      (email) => typeof email !== "string" || !/^[^\s@]+@[^\s@]+$/.test(email),
    );

    return bad === undefined ? undefined : `${quoted(bad)} is not an email address`;
  }

  if (Array.isArray(value) && key === "access.admin-service-tokens") {
    const bad = value.find((id) => typeof id !== "string" || !/^\S+$/.test(id));

    return bad === undefined ? undefined : `${quoted(bad)} is not a service token client id`;
  }

  return undefined;
};

const checkLeaf = (
  schema: Schema.Top,
  path: ReadonlyArray<string>,
  value: Json,
): SettingsProblem | undefined => {
  // SAFETY: the settings leaves are plain JSON schemas without decoding services.
  const decoded = Schema.decodeUnknownResult(schema as Schema.Decoder<unknown>)(value);

  if (Result.isFailure(decoded)) return invalid(path, decoded.failure.message);
  const message = valueRule(dotted(path), value);

  return message === undefined ? undefined : invalid(path, message);
};

const collect = (
  node: JsonObject,
  children: ReadonlyMap<string, PatchNode>,
  prefix: ReadonlyArray<string>,
  edits: SettingsEdit[],
): SettingsProblem | undefined => {
  for (const [key, value] of Object.entries(node)) {
    const path = [...prefix, key];
    const target = children.get(key);

    if (target === undefined)
      return problem(400, "not_a_setting", path, `${dotted(path)} is not a setting`);

    if (target.kind === "remove") {
      if (value !== null)
        return problem(
          400,
          "not_a_setting",
          path,
          `${dotted(path)} has no effect on Workers; it can only be removed (null)`,
        );
      edits.push({ path, value: null });
      continue;
    }

    if (target.kind === "section") {
      if (!isJsonObject(value)) return invalid(path, "must be a mapping of settings");
      const nested = collect(value, target.children, path, edits);

      if (nested !== undefined) return nested;
      continue;
    }

    if (value !== null) {
      const refused = checkLeaf(target.schema, path, value);

      if (refused !== undefined) return refused;
    }

    edits.push({ path, value });
  }

  return undefined;
};

/**
 * Reads a `PATCH /settings` patch into leaf edits, refusing the first path that is not a setting (`400
 * not_a_setting`) or whose value is invalid (`422 invalid_setting`).
 */
export const validateSettings = (
  patch: JsonObject,
): Result.Result<ReadonlyArray<SettingsEdit>, SettingsProblem> => {
  const edits: SettingsEdit[] = [];
  const refused = collect(patch, PATCH_ROOT, [], edits);

  return refused === undefined ? Result.succeed(edits) : Result.fail(refused);
};

/** The document with every edit applied: a value is written, `null` removes the key (missing keys are fine). */
export const applySettingsPatch = (
  document: JsonObject,
  edits: ReadonlyArray<SettingsEdit>,
): Result.Result<JsonObject, SettingsProblem> => {
  let out = document;

  for (const edit of edits) {
    if (edit.value === null) {
      out = deleteAtPath(out, edit.path) ?? out;
      continue;
    }

    const written = writeAtPath(out, edit.path, edit.value, "put");

    if (written === "invalid_path")
      return Result.fail(invalid(edit.path, "the stored document has no mapping at this path"));
    out = written;
  }

  return Result.succeed(out);
};

/**
 * Every written leaf must be stored as sent: `normalised` is the edited document after decoding (what the
 * ControlPlane stores). A leaf the normaliser rewrites (trimmed, lower-cased, clamped) is refused with its path.
 */
export const checkSurvival = (
  edits: ReadonlyArray<SettingsEdit>,
  normalised: Config,
): SettingsProblem | undefined => {
  // SAFETY: the encoded config is a plain JSON document (the schema's encoded side only holds JSON values).
  const stored = encodeConfig(normalised) as Json;

  for (const edit of edits) {
    if (edit.value === null) continue;
    const kept = getAtPath(stored, edit.path);

    if (kept === undefined || !jsonEquals(kept, edit.value))
      return invalid(
        edit.path,
        kept === undefined
          ? "would not be kept by the configuration"
          : `would be stored as ${JSON.stringify(kept)}`,
      );
  }

  return undefined;
};

const ADMIN_KEYS = new Set(["access.admin-emails", "access.admin-service-tokens"]);

const lockedOut = (after: Config, principal: Principal): SettingsProblem | undefined => {
  if (isAdmin(configAdminLists(after), principal)) return undefined;
  const key = principal.kind === "user" ? "admin-emails" : "admin-service-tokens";

  return problem(
    422,
    "would_remove_your_admin_access",
    ["access", key],
    "this change removes your own admin access; a deployment admin (ACCESS_ADMIN_*) can make it",
  );
};

/**
 * The lock-out guard: a caller who is an admin only through the config's `access.admin-*` lists must not remove
 * themselves (`alwaysAdmin`: a deployment admin, `ACCESS_ADMIN_*`, or the local dev bypass).
 */
export const checkAdminLockout = (input: {
  readonly edits: ReadonlyArray<SettingsEdit>;
  readonly after: Config;
  readonly principal: Principal;
  readonly alwaysAdmin: boolean;
}): SettingsProblem | undefined =>
  input.alwaysAdmin || !input.edits.some((edit) => ADMIN_KEYS.has(dotted(edit.path)))
    ? undefined
    : lockedOut(input.after, input.principal);

const SERVICE_TOKENS_PATH = ["access", "admin-service-tokens"] as const;

/**
 * Who may change `access.admin-service-tokens`: a service-token principal or a deployment admin (`alwaysAdmin`:
 * `ACCESS_ADMIN_*`, or the local dev bypass). An email admin who is only an admin through the config could otherwise
 * grant a service token admin rights (and with it the credential download, which is for service tokens only,
 * `credentials-routes.ts`). The list is compared as a set: reordering it changes nothing.
 */
export const checkServiceTokenAdmins = (input: {
  readonly before: Config;
  readonly after: Config;
  readonly principal: Principal;
  readonly alwaysAdmin: boolean;
}): SettingsProblem | undefined => {
  if (input.alwaysAdmin || input.principal.kind === "service") return undefined;

  const tokens = (config: Config): Json =>
    [...new Set(config.access["admin-service-tokens"])].toSorted();

  return jsonEquals(tokens(input.before), tokens(input.after))
    ? undefined
    : problem(
        403,
        "service_tokens_require_service_admin",
        SERVICE_TOKENS_PATH,
        "access.admin-service-tokens can only be changed with an Access service token that is an administrator, or by a deployment admin (ACCESS_ADMIN_*); see docs/ACCESS.md",
      );
};

/** {@link checkAdminLockout} for a whole-document write (the raw configuration): `before` is the stored config. */
export const checkDocumentLockout = (input: {
  readonly before: Config;
  readonly after: Config;
  readonly principal: Principal;
  readonly alwaysAdmin: boolean;
}): SettingsProblem | undefined => {
  const lists = (config: Config): Json => [
    [...config.access["admin-emails"]],
    [...config.access["admin-service-tokens"]],
  ];

  return input.alwaysAdmin || jsonEquals(lists(input.before), lists(input.after))
    ? undefined
    : lockedOut(input.after, input.principal);
};

// --- view ----------------------------------------------------------------------------------------------------------

const valuesJson = (tree: Tree, source: Json, prefix: ReadonlyArray<string>): JsonObject =>
  Object.fromEntries(
    Object.entries(tree).map(([key, node]) => {
      const path = [...prefix, key];

      // A missing leaf is an unset Go pointer (`null` in the view).
      return [
        key,
        Schema.isSchema(node) ? (getAtPath(source, path) ?? null) : valuesJson(node, source, path),
      ];
    }),
  );

const decodeValues = Schema.decodeUnknownSync(SettingsValues);

/** The Settings-owned values of `config` (defaults filled, unset tri-states `null`). */
export const settingsValues = (config: Config): SettingsValuesType =>
  // SAFETY: the encoded config is a plain JSON document (the schema's encoded side only holds JSON values).
  decodeValues(valuesJson(SETTINGS_TREE, encodeConfig(config) as Json, []));

let defaultValues: SettingsValuesType | undefined;

const defaults = (): SettingsValuesType =>
  (defaultValues ??= settingsValues(Schema.decodeUnknownSync(Config)({})));

export interface SettingsViewInput {
  readonly config: Config;
  readonly version: number;
  /** Epoch milliseconds of the last write; 0 when nothing was stored. */
  readonly updatedAt: number;
  readonly envAdmins: AdminLists;
  readonly prefixedCredentials: number;
}

/** `GET /settings`: values, defaults and the read-only context. Never carries a secret. */
export const settingsView = (input: SettingsViewInput): SettingsView => {
  const { config } = input;
  const payload = config.requests.payload;

  return {
    version: input.version,
    ...(input.updatedAt > 0 ? { updated_at: new Date(input.updatedAt).toISOString() } : {}),
    values: settingsValues(config),
    defaults: defaults(),
    not_applied: notAppliedRules(config).map((rule) => ({ key: rule.key, reason: rule.reason })),
    env_admins: {
      emails: [...input.envAdmins.adminEmails].toSorted(),
      service_tokens: [...input.envAdmins.adminServiceTokens].toSorted(),
    },
    payload: {
      default: payload.default.length,
      "default-raw": payload["default-raw"].length,
      override: payload.override.length,
      "override-raw": payload["override-raw"].length,
      filter: payload.filter.length,
    },
    prefixed_credentials: input.prefixedCredentials,
    request_scoped_errors: config.oauth["request-scoped-errors"],
  };
};
