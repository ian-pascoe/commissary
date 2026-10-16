/**
 * "Stored wins" for provider keys that duplicate another one, for the group write (`provider-keys-write.ts`).
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
 * (`config/normalize.ts`).
 */
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

/** Copy of `document` without the keys `drops` marks in the `family` groups (a group may be left without keys). */
export const withoutKeys = (
  document: JsonObject,
  family: string,
  drops: ReadonlyArray<ReadonlyArray<boolean>>,
): JsonObject => {
  if (drops.every((group) => group.every((drop) => !drop))) return document;
  const out = structuredClone(document);
  const providerKeys = out["api-keys"];
  const groups = isJsonObject(providerKeys) ? providerKeys[family] : undefined;

  if (!Array.isArray(groups)) return out;

  for (const [position, group] of groups.entries()) {
    if (!isJsonObject(group) || !Array.isArray(group.keys)) continue;
    const marks = drops[position] ?? [];
    group.keys = group.keys.filter((_, key) => marks[key] !== true);
  }

  return out;
};
