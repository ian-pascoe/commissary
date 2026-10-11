/**
 * "Stored wins" for API keys that duplicate another one, shared by the group write (`api-keys-write.ts`), the raw
 * configuration editor (`settings-raw.ts`) and the path writes of `/config/*path` (`config-routes.ts`).
 *
 * Workers deviation, no Go counterpart: Go's `Sanitize*Keys` keeps the first of a family's duplicates (gemini,
 * interactions and vertex keys are unique across groups, `config/normalize.ts`). Left to the normaliser, a typed key
 * equal to a stored key of a *later* group would delete the stored one (and its group, when it was the only key). A
 * management write must never lose a stored key to something typed, so the typed copy goes instead, before the
 * normaliser runs. Typed text is never compared with stored secrets by value: both sides are compared through the
 * normaliser's own uniqueness ids, and the reply of a write never says whether a copy was dropped (the next read
 * does), so a right guess cannot be told from a wrong one.
 *
 * `typedDuplicates` and `withoutKeys` are pure functions over a document and the ids of `keyIdentities`
 * (`config/normalize.ts`); `keepStoredKeys` applies them to a whole document.
 */
import { Effect } from "effect";
import { decodeRawConfig } from "../config/codec.ts";
import { DEDUPED_FAMILIES, type DedupedFamily, keyIdentities } from "../config/normalize.ts";
import { isJsonObject, type JsonObject } from "../json/index.ts";

/** Which keys of the groups, `[group][key]`, were typed by the caller (a stored one is kept by reference). */
export type TypedKeys = ReadonlyArray<ReadonlyArray<boolean>>;

/**
 * Which keys `[group][key]` to drop: a typed key whose id belongs to a key that is not typed (in any group), or to an
 * earlier typed key. Keys that are not typed are never dropped here (two stored keys that became equal are the
 * normaliser's business: first wins, and the write that made them equal is not about a guess).
 */
export const typedDuplicates = (
  identities: ReadonlyArray<ReadonlyArray<string>>,
  typed: TypedKeys,
): ReadonlyArray<ReadonlyArray<boolean>> => {
  const seen = new Set<string>();

  for (const [group, ids] of identities.entries())
    for (const [key, id] of ids.entries()) if (typed[group]?.[key] !== true) seen.add(id);

  return identities.map((ids, group) =>
    ids.map((id, key) => {
      if (typed[group]?.[key] !== true) return false;

      if (seen.has(id)) return true;
      seen.add(id);

      return false;
    }),
  );
};

/** Whether two config paths are the same, or one is inside the other. */
const related = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
  a.slice(0, b.length).every((part, index) => part === b[index]) &&
  b.slice(0, a.length).every((part, index) => part === a[index]);

/**
 * Which keys of the `family` groups of `document` a write at `parts` put in: the key at, under or containing that path
 * (`api-keys.<family>.<group>.keys.<key>`). The others are the stored ones, which the write carries over. (A path cannot
 * address one list element today, so a write at the family list or above types every key of the family; this keeps a
 * write at a deeper path safe should paths ever reach into lists.)
 */
export const typedKeysAt = (
  document: JsonObject,
  family: string,
  parts: ReadonlyArray<string>,
): TypedKeys => {
  const apiKeys = document["api-keys"];
  const groups = isJsonObject(apiKeys) ? apiKeys[family] : undefined;

  return (Array.isArray(groups) ? groups : []).map((group, at) => {
    const keys = isJsonObject(group) && Array.isArray(group.keys) ? group.keys : [];

    return keys.map((_, key) => related(["api-keys", family, `${at}`, "keys", `${key}`], parts));
  });
};

/**
 * `document` without the typed keys that duplicate a stored one (or an earlier typed one), for every family Go
 * deduplicates. `typed(family)` says which keys, `[group][key]` in the document, the caller wrote. A document that does
 * not decode is returned as it is: the caller's own validation reports why.
 */
export const keepStoredKeys = (
  document: JsonObject,
  typed: (family: DedupedFamily) => TypedKeys,
): Effect.Effect<JsonObject> =>
  decodeRawConfig(document).pipe(
    Effect.map((written) =>
      DEDUPED_FAMILIES.reduce(
        (out, family) =>
          withoutKeys(out, family, typedDuplicates(keyIdentities(family, written), typed(family))),
        document,
      ),
    ),
    Effect.catch(() => Effect.succeed(document)),
  );

/** Copy of `document` without the keys `drops` marks in the `family` groups (a group may be left without keys). */
export const withoutKeys = (
  document: JsonObject,
  family: string,
  drops: ReadonlyArray<ReadonlyArray<boolean>>,
): JsonObject => {
  if (drops.every((group) => group.every((drop) => !drop))) return document;
  const out = structuredClone(document);
  const apiKeys = out["api-keys"];
  const groups = isJsonObject(apiKeys) ? apiKeys[family] : undefined;

  if (!Array.isArray(groups)) return out;

  for (const [position, group] of groups.entries()) {
    if (!isJsonObject(group) || !Array.isArray(group.keys)) continue;
    const marks = drops[position] ?? [];
    group.keys = group.keys.filter((_, key) => marks[key] !== true);
  }

  return out;
};
