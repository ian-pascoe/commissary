/**
 * Path-addressed edits of the config document served by `/v8/management/config[/*path]`.
 *
 * Go source: internal/api/handlers/management/config_v8.go (`configV8Node`, `deleteConfigV8Path`,
 * `mergeConfigV8Patch`, the write path of `ConfigV8`) and config_auth_index.go (`auth_index` stripping on writes; Go's
 * injection on reads is not ported: its only consumer was the upstream panel's `api-call`).
 * Paths address mapping keys, never array indexes; lists and scalars are replaced whole, `PATCH` deep-merges objects
 * (explicit `null` is kept: DELETE is the removal operation). The Go read-only Home revision paths do not exist in
 * the Workers config schema, so there is nothing to protect. All functions work on a private copy of the document.
 */
import type { ApiKeyFamily, Config } from "../config/schema.ts";
import { isJsonObject, type Json, type JsonObject } from "../json/index.ts";
import { setOwn } from "../json/value.ts";
import { synthesizeConfigCredentials } from "../credentials/synthesize.ts";

/**
 * Segments no path may name (deviation from Go, where they are ordinary map keys): written through a plain JavaScript
 * object they would reach `Object.prototype`.
 */
const RESERVED_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * `/a/b/c` (percent-decoded segments) -> `["a","b","c"]`; `undefined` for an empty segment in the middle or a
 * reserved one (`__proto__`, `constructor`, `prototype`).
 */
export const parseConfigPath = (rest: string): ReadonlyArray<string> | undefined => {
  const trimmed = rest.replace(/^\/+|\/+$/g, "");

  if (trimmed === "") return [];

  const parts = trimmed.split("/").map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });

  return parts.some((part) => part === "" || RESERVED_SEGMENTS.has(part)) ? undefined : parts;
};

/**
 * The config path of a `/v8/management/config/*` request: the URL path with its prefix read as the router matched it
 * (duplicate slashes skipped, each segment percent-decoded, compared case-insensitively), the segments after `config`
 * still encoded so `%2F` stays inside one key (`parseConfigPath` decodes them). `undefined` when the prefix is not
 * `/v8/management/config`.
 */
const decodedSegment = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

export const configPathOfUrl = (url: string): string | undefined => {
  const pathname = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url)
    ? new URL(url).pathname
    : (url.split(/[?#]/)[0] ?? "");

  const segments = pathname.split("/");
  let index = 0;

  // The prefix as the router matches it; the rest keeps its empty segments (`a//b` is an invalid path, as in Go).
  for (const expected of ["v8", "management", "config"]) {
    while (segments[index] === "") index++;
    const segment = segments[index];

    if (segment === undefined || decodedSegment(segment).toLowerCase() !== expected)
      return undefined;
    index++;
  }

  return `/${segments.slice(index).join("/")}`;
};

/** Value at `parts`, or `undefined` when a key is missing or a non-object is traversed. */
export const getAtPath = (root: Json, parts: ReadonlyArray<string>): Json | undefined => {
  let current: Json | undefined = root;

  for (const part of parts) {
    if (!isJsonObject(current) || !Object.hasOwn(current, part)) return undefined;
    current = current[part];
  }

  return current;
};

/** `mergeConfigV8Patch`: objects merge recursively, everything else is replaced by the patch. */
export const mergePatch = (target: Json | undefined, patch: Json): Json => {
  if (!isJsonObject(target) || !isJsonObject(patch)) return structuredClone(patch);
  const out: JsonObject = { ...target };

  for (const [key, value] of Object.entries(patch)) {
    // A `__proto__` key (own, from JSON.parse) would replace the prototype of `out` when assigned.
    if (key === "__proto__") continue;
    out[key] = Object.hasOwn(out, key) ? mergePatch(out[key], value) : structuredClone(value);
  }

  return out;
};

export type WriteMode = "put" | "patch";

/**
 * Returns a copy of `document` with `value` written at `parts` (intermediate objects are created).
 * `"invalid_path"` when an intermediate value exists and is not an object.
 */
export const writeAtPath = (
  document: JsonObject,
  parts: ReadonlyArray<string>,
  value: Json,
  mode: WriteMode,
): JsonObject | "invalid_path" => {
  if (parts.length === 0)
    // SAFETY: an empty path replaces or patches the root, which callers only pass as an object.
    return (mode === "patch" ? mergePatch(document, value) : structuredClone(value)) as JsonObject;
  const root = structuredClone(document);
  let parent: JsonObject = root;

  for (const part of parts.slice(0, -1)) {
    const next = Object.hasOwn(parent, part) ? parent[part] : undefined;

    if (next === undefined) {
      const created: JsonObject = {};
      setOwn(parent, part, created);
      parent = created;
    } else if (isJsonObject(next)) {
      parent = next;
    } else {
      return "invalid_path";
    }
  }

  // SAFETY: parts is non-empty: the empty path returned above.
  const leaf = parts[parts.length - 1] as string;
  const current = Object.hasOwn(parent, leaf) ? parent[leaf] : undefined;

  setOwn(parent, leaf, mode === "patch" ? mergePatch(current, value) : structuredClone(value));

  return root;
};

const removeAt = (node: JsonObject, rest: ReadonlyArray<string>): boolean => {
  // SAFETY: removeAt is only called with a non-empty path.
  const [head, ...tail] = rest as [string, ...string[]];

  if (!Object.hasOwn(node, head)) return false;

  if (tail.length > 0) {
    const child = node[head];

    if (!isJsonObject(child) || !removeAt(child, tail)) return false;

    if (Object.keys(child).length > 0) return true;
  }

  delete node[head];

  return true;
};

/** `deleteConfigV8Path`: removes the key and prunes parents that became empty; `undefined` when it does not exist. */
export const deleteAtPath = (
  document: JsonObject,
  parts: ReadonlyArray<string>,
): JsonObject | undefined => {
  if (parts.length === 0) return undefined;
  const root = structuredClone(document);

  return removeAt(root, parts) ? root : undefined;
};

// --- config key ids ---------------------------------------------------------------------------------------------

const FAMILY_PROVIDERS: Readonly<Record<Exclude<ApiKeyFamily, "openai-compatibility">, string>> = {
  gemini: "gemini",
  interactions: "gemini-interactions",
  vertex: "vertex",
  codex: "codex",
  claude: "claude",
  xai: "xai",
  meta: "meta",
  "opencode-zen": "opencode-zen",
  "opencode-go": "opencode-go",
};

/** Credential ids of one group: one per key (`undefined` when the key produced no credential). */
export interface GroupKeyIds {
  readonly keys: ReadonlyArray<string | undefined>;
  /** A key-less OpenAI-compatibility group still produces one credential: its id. */
  readonly group?: string;
}

/** Per family and group index: the ids of the credentials `synthesizeConfigCredentials` made for them. */
export type ConfigKeyIds = Readonly<Record<ApiKeyFamily, ReadonlyArray<GroupKeyIds>>>;

export interface ConfigKeyIdsOptions {
  /**
   * Also give the keys of a disabled OpenAI-compatibility group an id (as if the group were enabled), so the panel
   * can still address them. Off by default: a disabled group has no credentials (as in Go).
   */
  readonly includeDisabledGroups?: boolean;
}

/**
 * Maps every position in `config["api-keys"]` (family, group, key) to the id of the credential it produced, through
 * the synthesised credentials (`attributes.config_index`), the same order the credential pool uses. Shared by the
 * ControlPlane and the API keys view/writes, so both agree on which key an `auth_index` names.
 */
export const configKeyIds = (
  config: Pick<Config, "api-keys">,
  options: ConfigKeyIdsOptions = {},
): ConfigKeyIds => {
  const apiKeys = config["api-keys"];

  const synthesised: Pick<Config, "api-keys"> =
    options.includeDisabledGroups === true
      ? {
          "api-keys": {
            ...apiKeys,
            "openai-compatibility": apiKeys["openai-compatibility"].map((group) =>
              group.disabled === true ? { ...group, disabled: false } : group,
            ),
          },
        }
      : config;

  const byPosition = new Map<string, string>();
  const compat = new Map<string, string[]>();

  for (const credential of synthesizeConfigCredentials(synthesised, 0)) {
    const index = credential.attributes.config_index;

    if (index === undefined) continue;

    if (credential.attributes.compat_name !== undefined) {
      const list = compat.get(index) ?? [];
      list.push(credential.id);
      compat.set(index, list);
    } else {
      byPosition.set(`${credential.provider}:${index}`, credential.id);
    }
  }

  const grouped = (family: Exclude<ApiKeyFamily, "openai-compatibility">): GroupKeyIds[] => {
    const provider = FAMILY_PROVIDERS[family];
    let position = 0;

    return apiKeys[family].map((group) => ({
      keys: group.keys.map(() => {
        const id = byPosition.get(`${provider}:${position}`);
        position += 1;

        return id;
      }),
    }));
  };

  return {
    gemini: grouped("gemini"),
    interactions: grouped("interactions"),
    vertex: grouped("vertex"),
    codex: grouped("codex"),
    claude: grouped("claude"),
    xai: grouped("xai"),
    meta: grouped("meta"),
    "opencode-zen": grouped("opencode-zen"),
    "opencode-go": grouped("opencode-go"),
    "openai-compatibility": apiKeys["openai-compatibility"].map((group, index) => {
      const ids = compat.get(String(index)) ?? [];

      return {
        keys: group.keys.map((_, keyIndex) => ids[keyIndex]),
        ...(group.keys.length === 0 && ids[0] !== undefined ? { group: ids[0] } : {}),
      };
    }),
  };
};

const stripNode = (node: Json | undefined): void => {
  if (!isJsonObject(node)) return;
  delete node.auth_index;
  delete node["auth-index"];
};

/** `stripAPIKeysAuthIndexesFromRoot`: `auth_index` is derived data and must never be stored. */
export const stripAuthIndexes = (document: JsonObject): JsonObject => {
  const out = structuredClone(document);
  const apiKeys = out["api-keys"];

  if (!isJsonObject(apiKeys)) return out;

  for (const groups of Object.values(apiKeys)) {
    if (!Array.isArray(groups)) continue;

    for (const group of groups) {
      stripNode(group);
      const keys = isJsonObject(group) ? group.keys : undefined;

      if (Array.isArray(keys)) keys.forEach(stripNode);
    }
  }

  return out;
};
