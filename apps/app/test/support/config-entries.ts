/**
 * The config import as a pure function, for tests that compare it with decoding (`config.test.ts`,
 * `config-normalize.test.ts`, `config-entries.test.ts`): the rows `ConfigStore.importDocument` stores for a decoded
 * config, through JSON (as SQLite holds them), assembled and decoded again like `ConfigStore.current`.
 */
import { assert } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { decodeConfig, encodeConfig } from "../../src/config/codec.ts";
import { documentOfEntries, entriesOfConfig, type EntryRows } from "../../src/config/entries.ts";
import { NOT_APPLIED_RULES } from "../../src/config/not-applied.ts";
import { Config } from "../../src/config/schema.ts";
import { assignEntryIds, withoutEntryIds } from "../../src/credentials/key-ids.ts";
import { get, isJsonArray, isJsonObject, type Json, set } from "@commissary/json";

/** The config an import of `config` assembles (entry ids included). */
export const importedConfig = (config: Config): Config => {
  let next = 0;

  const rows = entriesOfConfig(assignEntryIds(withoutEntryIds(config)), () => {
    next += 1;

    return `payload:${next}`;
  });

  // SAFETY: the rows are plain JSON (that is how the store keeps them).
  const stored = JSON.parse(JSON.stringify(rows)) as EntryRows;

  return Effect.runSync(decodeConfig(documentOfEntries(stored)));
};

/**
 * `config` as an import keeps it: without entry ids, every not-applied key at its default (the import drops them)
 * and no `experimental-cch-signing` on provider keys.
 */
export const comparable = (config: Config): Config => {
  // SAFETY: the config schema encodes to a plain JSON object.
  let document = structuredClone(encodeConfig(withoutEntryIds(config))) as Json;
  // SAFETY: as above.
  const defaults = encodeConfig(Schema.decodeUnknownSync(Config)({})) as Json;

  for (const rule of NOT_APPLIED_RULES) {
    const path = rule.path?.join(".");
    const value = path === undefined ? undefined : get(defaults, path);

    if (path !== undefined && value !== undefined) document = set(document, path, value);
  }

  const providerKeys = isJsonObject(document) ? document["api-keys"] : undefined;

  for (const groups of isJsonObject(providerKeys) ? Object.values(providerKeys) : [])
    for (const group of isJsonArray(groups) ? groups : [])
      for (const key of isJsonObject(group) && isJsonArray(group.keys) ? group.keys : [])
        if (isJsonObject(key)) delete key["experimental-cch-signing"];

  return Schema.decodeUnknownSync(Config)(document);
};

/** Asserts that importing `config` as entries assembles the same config, modulo entry ids and not-applied keys. */
export const assertImportKeeps = (config: Config): Effect.Effect<void> =>
  Effect.sync(() => assert.deepStrictEqual(comparable(importedConfig(config)), comparable(config)));
