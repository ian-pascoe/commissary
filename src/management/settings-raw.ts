/**
 * The raw configuration pipeline behind `settings-raw-routes.ts` (contract `settings.ts` `raw` / `checkRaw` /
 * `saveRaw`): masked YAML for the editor, and edited YAML back to a validated document with its secrets restored.
 *
 * Workers addition, no Go counterpart (Go's panel edits `config.yaml` with every secret in the clear). Only the
 * canonical JSON document is stored, so comments and key order are lost, anchors are expanded (`toJS`), custom tags
 * and merge keys (`<<`) are refused. After decoding, a
 * second decode with stand-ins for the restored secrets gives the review (`reviewResult`) and the fail-safe: a
 * stand-in the masking would show refuses the edit (`exposedTagPath`). Known gaps of the review: a typed copy of a
 * stored secret is deduplicated with it without the review showing it (typed values are never compared with stored
 * ones); kept secrets sharing a stored value get one more decode with shared stand-ins (`sharedDropped`), so a dedupe
 * an edit causes among them is listed in `dropped`. `%YAML 1.1` is refused (its schema resolves
 * timestamps, binary, sets and merges whatever the parse options say). Messages never quote a value: a YAML error
 * is a fixed sentence per error code (`yaml-message.ts`) with its line and column, a config error is value-free
 * (`config/codec.ts`) and names at most the keys the caller wrote; they are not scrubbed of stored secrets (a
 * scrubbed echo would tell a right guess from a wrong one).
 */
import { Effect } from "effect";
import { Document, isScalar, LineCounter, parseDocument, Scalar, visit } from "yaml";
import { decodeConfig, encodeConfig, sparseDocument } from "../config/codec.ts";
import { prepareDocument } from "../config/document.ts";
import { ConfigValidationError, configPath } from "../config/errors.ts";
import { notAppliedSettings } from "../config/not-applied.ts";
import { yamlMessage } from "../config/yaml-message.ts";
import type { Config } from "../config/schema.ts";
import { isJsonObject, type Json, type JsonObject, jsonEquals } from "../json/index.ts";
import {
  exposedTagPath,
  type RestoredSecret,
  restoreSecrets,
  type ReviewedResult,
  reviewResult,
  type SecretTags,
  secretTags,
} from "./config-secrets.ts";

/** A refused raw configuration: `{error, message, path?, line?, column?}` with status 422. */
export interface RawProblem {
  readonly error: string;
  readonly message: string;
  readonly path?: string;
  readonly line?: number;
  readonly column?: number;
}

/** An edited raw configuration, read and checked. */
export interface RawEdit {
  /** The prepared document with its secrets restored: what is stored. */
  readonly document: JsonObject;
  readonly config: Config;
  /** `encodeConfig(config)`: the document as the ControlPlane will store it. */
  readonly canonical: JsonObject;
  /** Stored secrets the edit kept through their placeholders. */
  readonly restored: ReadonlyArray<RestoredSecret>;
  /** The result masked for the review, kept and new secrets told apart by origin (`reviewResult`). */
  readonly review: ReviewedResult;
  readonly dropped: ReadonlyArray<string>;
  readonly notApplied: ReadonlyArray<string>;
}

const PLACEHOLDER = /\[(?:redacted#\d+|new secret)\]/;

/**
 * `masked` (a document whose secrets are placeholders) as YAML without defaults; placeholders are double-quoted (a
 * leading `[` would otherwise read as a list).
 */
export const maskedYaml = (masked: JsonObject): string => {
  const document = new Document(sparseDocument(masked));

  visit(document, {
    Scalar: (_, node) => {
      if (typeof node.value === "string" && PLACEHOLDER.test(node.value))
        node.type = Scalar.QUOTE_DOUBLE;
    },
  });

  return document.toString({ lineWidth: 0 });
};

// --- messages ------------------------------------------------------------------------------------------------------

const isMergeKey = (key: unknown): key is Scalar =>
  isScalar(key) &&
  (key.type === undefined || key.type === Scalar.PLAIN) &&
  (key.value === "<<" || (typeof key.value === "symbol" && key.value.description === "<<"));

/**
 * Where the first plain `<<` key starts. `%YAML 1.1` turns merge keys on whatever the parse options say, and a merge
 * copies mappings around (placeholders included) where the text does not show it: refused in either version.
 */
const mergeKeyOffset = (document: Document): number | undefined => {
  let offset: number | undefined;

  visit(document, {
    Pair: (_, pair) => {
      if (!isMergeKey(pair.key)) return undefined;
      offset = pair.key.range?.[0] ?? 0;

      return visit.BREAK;
    },
  });

  return offset;
};

/** Tag problems are warnings for the `yaml` library; here a custom tag is an error (it would be silently lost). */
const REFUSED_WARNINGS = new Set(["TAG_RESOLVE_FAILED", "BAD_COLLECTION_TYPE"]);

/** Parses YAML text (or JSON) into a JSON value; an empty document is `{}`. */
const parseYaml = (text: string): Effect.Effect<Json, RawProblem> =>
  Effect.suspend(() => {
    const lines = new LineCounter();

    // `resolveKnownTags: false`: the YAML 1.1 tags the core schema would still resolve (`!!binary`, `!!timestamp`,
    // `!!set`, `!!omap`, `!!pairs`, `!!merge`) stay unresolved and are refused below.
    const document = parseDocument(text, {
      lineCounter: lines,
      prettyErrors: false,
      resolveKnownTags: false,
    });

    // `%YAML 1.1` switches to a schema that resolves those tags, timestamps and merge keys whatever the options say.
    if (document.schema.name !== "core") {
      const { line, col } = lines.linePos(Math.max(0, text.search(/^%YAML/m)));

      return Effect.fail({
        error: "invalid_yaml",
        message: "only YAML 1.2 is supported",
        line,
        column: col,
      });
    }

    const error =
      document.errors[0] ?? document.warnings.find((warning) => REFUSED_WARNINGS.has(warning.code));

    if (error !== undefined) {
      const { line, col } = lines.linePos(error.pos[0]);

      return Effect.fail({
        error: "invalid_yaml",
        message: yamlMessage(error),
        line,
        column: col,
      });
    }

    const merge = mergeKeyOffset(document);

    if (merge !== undefined) {
      const { line, col } = lines.linePos(merge);

      return Effect.fail({
        error: "invalid_yaml",
        message: "merge keys (<<) are not supported",
        line,
        column: col,
      });
    }

    return Effect.try({
      // SAFETY: the core schema yields JSON values only (plain objects, arrays, strings, numbers, booleans, null).
      try: () => (document.toJS() ?? {}) as Json,
      // Alias resolution errors name the alias (source text): a fixed message instead.
      catch: () => ({ error: "invalid_yaml", message: "invalid YAML: unresolvable aliases" }),
    });
  });

/** Config errors are value-free (`config/codec.ts`): passed on as they are, never scrubbed (that is an oracle). */
const invalidConfig = (error: ConfigValidationError): RawProblem => {
  const problem = { error: "invalid_config", message: error.message };

  return error.path === undefined ? problem : { ...problem, path: error.path };
};

// --- dropped paths -------------------------------------------------------------------------------------------------

/** Whether every leaf of `input` is in `output` with the same value (lists: same length, item by item). */
const covers = (input: Json, output: Json | undefined): boolean => {
  if (output === undefined) return false;

  if (isJsonObject(input))
    return (
      isJsonObject(output) &&
      Object.entries(input).every(([key, value]) =>
        covers(value, Object.hasOwn(output, key) ? output[key] : undefined),
      )
    );

  if (Array.isArray(input))
    return (
      Array.isArray(output) &&
      input.length === output.length &&
      input.every((item, index) => covers(item, output[index]))
    );

  return jsonEquals(input, output);
};

const collectDropped = (
  input: Json,
  output: Json | undefined,
  path: ReadonlyArray<string | number>,
  out: string[],
): void => {
  if (covers(input, output)) return;

  if (isJsonObject(input) && isJsonObject(output)) {
    for (const [key, value] of Object.entries(input)) {
      if (Object.hasOwn(output, key)) collectDropped(value, output[key], [...path, key], out);
      else out.push(configPath([...path, key]));
    }

    return;
  }

  if (Array.isArray(input) && Array.isArray(output)) {
    if (input.length === output.length) {
      input.forEach((item, index) => collectDropped(item, output[index], [...path, index], out));

      return;
    }

    // Items were removed (duplicates, groups the normaliser rejects): report the ones without a match.
    const used = new Set<number>();

    input.forEach((item, index) => {
      const match = output.findIndex(
        (candidate, position) => !used.has(position) && covers(item, candidate),
      );

      if (match < 0) out.push(configPath([...path, index]));
      else used.add(match);
    });

    return;
  }

  out.push(configPath(path));
};

/**
 * Paths of `input` (a prepared document) that `canonical` (its decoded, normalised form) does not keep as written:
 * unknown or Workers-only keys, entries the normaliser removes, values it rewrites.
 */
export const droppedPaths = (input: JsonObject, canonical: JsonObject): ReadonlyArray<string> => {
  const out: string[] = [];

  collectDropped(input, canonical, [], out);

  return out;
};

// --- the edit ------------------------------------------------------------------------------------------------------

const secretKey = (kind: string, value: string): string => `${kind}\u0000${value}`;

/**
 * `dropped` when kept secrets share a stored value (two slots, same key): the review decode gives them different
 * stand-ins, so it would not see the normaliser deduplicate them once an edit makes their identities equal (e.g.
 * Gemini groups that differ only by `prefix`). Decoded once more with one stand-in per stored value, the dedupe
 * happens as in the stored decode and shows in `dropped`. Only kept secrets are compared with each other, never with
 * typed values, so this is no guessing oracle. `undefined` when no kept secrets share a value (the common case).
 */
const sharedDropped = Effect.fnUntraced(function* (
  prepared: JsonObject,
  stored: JsonObject,
  restored: ReadonlyArray<RestoredSecret>,
  tags: SecretTags,
): Effect.fn.Return<ReadonlyArray<string> | undefined, RawProblem> {
  const first = new Map<string, number>();

  for (const secret of restored) {
    const key = secretKey(secret.kind, secret.value);
    const known = first.get(key);

    if (known === undefined || secret.index < known) first.set(key, secret.index);
  }

  if (restored.every((secret) => first.get(secretKey(secret.kind, secret.value)) === secret.index))
    return undefined;

  const merged = restoreSecrets(prepared, stored, (index, slot) =>
    tags.standIn(first.get(secretKey(slot.kind, slot.value)) ?? index, slot),
  );

  if (!merged.ok) return undefined;

  const config = yield* decodeConfig(merged.document).pipe(
    Effect.mapError((error) => invalidConfig(error)),
  );

  // SAFETY: the encoded config is a plain JSON object (the schema's encoded side only holds JSON values).
  return droppedPaths(merged.document, encodeConfig(config) as JsonObject);
});

/**
 * Reads edited YAML against the stored document: parse, prepare (v8 layout, `auth_index` stripped), validate, restore
 * the secrets behind `[redacted#n]`, decode and normalise. `stored` must be the document the placeholders were made
 * from (same version).
 */
export const readRawEdit = Effect.fnUntraced(function* (
  text: string,
  stored: JsonObject,
): Effect.fn.Return<RawEdit, RawProblem> {
  const raw = yield* parseYaml(text);

  const prepared = yield* Effect.try({
    try: () => prepareDocument(raw),
    catch: (error) =>
      invalidConfig(
        error instanceof ConfigValidationError
          ? error
          : new ConfigValidationError({ message: "invalid config document" }),
      ),
  });

  // Validated before the secrets are restored, so a refusal depends only on what the caller sent.
  yield* decodeConfig(prepared).pipe(Effect.mapError((error) => invalidConfig(error)));
  const restored = restoreSecrets(prepared, stored);

  if (!restored.ok) return yield* Effect.fail<RawProblem>(restored.problem);

  const config = yield* decodeConfig(restored.document).pipe(
    Effect.mapError((error) => invalidConfig(error)),
  );

  // SAFETY: the encoded config is a plain JSON object (the schema's encoded side only holds JSON values).
  const canonical = encodeConfig(config) as JsonObject;

  // The review decodes the edit again with unguessable stand-ins for the restored secrets, so it tells kept from new
  // secrets (and what was dropped) by origin: nothing in it depends on whether a typed value equals a stored secret.
  const tags = secretTags(`t${crypto.randomUUID().replaceAll("-", "")}`);
  const tagged = restoreSecrets(prepared, stored, tags.standIn);

  if (!tagged.ok) return yield* Effect.fail<RawProblem>(tagged.problem);

  const taggedConfig = yield* decodeConfig(tagged.document).pipe(
    Effect.mapError((error) => invalidConfig(error)),
  );

  // SAFETY: as above.
  const taggedCanonical = encodeConfig(taggedConfig) as JsonObject;

  // Fail-safe: a stand-in the masking would show is a restored secret the normaliser took out of a secret position.
  const exposed = exposedTagPath(taggedCanonical, tags);

  if (exposed !== undefined)
    return yield* Effect.fail<RawProblem>({
      error: "masked_value_outside_secret_field",
      message: "a masked secret would end up where secrets are shown",
      path: exposed,
    });

  return {
    document: restored.document,
    config,
    canonical,
    restored: restored.restored,
    review: reviewResult(taggedCanonical, stored, tags),
    dropped: yield* sharedDropped(prepared, stored, restored.restored, tags).pipe(
      Effect.map((dropped) => dropped ?? droppedPaths(tagged.document, taggedCanonical)),
    ),
    notApplied: notAppliedSettings(config),
  };
});
