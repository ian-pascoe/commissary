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
 * timestamps, binary, sets and merges whatever the parse options say). Nothing secret reaches a message: YAML errors whose text would quote the source are reduced to their
 * kind, and config errors are decoded on the edited document (placeholders, not stored secrets), then scrubbed of
 * every secret of either document.
 */
import { Effect } from "effect";
import {
  Document,
  isScalar,
  LineCounter,
  parseDocument,
  Scalar,
  visit,
  type YAMLError,
} from "yaml";
import { decodeConfig, encodeConfig, sparseDocument } from "../config/codec.ts";
import { prepareDocument } from "../config/document.ts";
import { ConfigValidationError, configPath } from "../config/errors.ts";
import { notAppliedSettings } from "../config/not-applied.ts";
import type { Config } from "../config/schema.ts";
import { isJsonObject, type Json, type JsonObject, jsonEquals } from "../json/index.ts";
import {
  exposedTagPath,
  type RestoredSecret,
  restoreSecrets,
  type ReviewedResult,
  reviewResult,
  type SecretTags,
  secretSlots,
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

/** Every non-empty secret replaced in `message` (quoted forms always, bare ones from four characters). */
export const scrub = (message: string, secrets: ReadonlyArray<string>): string =>
  secrets
    .filter((secret) => secret !== "")
    .toSorted((a, b) => b.length - a.length)
    .reduce((out, secret) => {
      const quoted = JSON.stringify(secret);
      const escaped = quoted.slice(1, -1);
      let next = out.replaceAll(quoted, '"[redacted]"');

      if (secret.length >= 4) next = next.replaceAll(secret, "[redacted]");

      return escaped.length >= 4 ? next.replaceAll(escaped, "[redacted]") : next;
    }, message);

/** YAML messages that end with a piece of the source (which could be a secret): only their kind is kept. */
const QUOTING_MESSAGES = [
  "Block scalar header includes extra characters",
  "Unresolved tag",
  "Invalid escape sequence",
  "Plain value cannot start with",
  "Not a valid tag",
  "Could not resolve tag",
  "Unknown directive",
  "Unsupported YAML version",
  "Unresolved plain scalar",
  "Ordered maps must not include duplicate keys",
];

const yamlMessage = (error: YAMLError): string => {
  if (error.code === "TAG_RESOLVE_FAILED" || error.code === "BAD_COLLECTION_TYPE")
    return "custom tags are not supported";
  const quoting = QUOTING_MESSAGES.find((prefix) => error.message.startsWith(prefix));

  if (quoting !== undefined) return quoting;

  return /^Verbatim tags|^The .* tag has no suffix/.test(error.message)
    ? "invalid tag"
    : error.message;
};

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
const parseYaml = (text: string, secrets: ReadonlyArray<string>): Effect.Effect<Json, RawProblem> =>
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
        message: scrub(yamlMessage(error), secrets),
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
      catch: (cause) => ({
        error: "invalid_yaml",
        message: scrub(cause instanceof Error ? cause.message : String(cause), secrets),
      }),
    });
  });

const invalidConfig = (
  error: ConfigValidationError,
  secrets: ReadonlyArray<string>,
): RawProblem => {
  const problem = { error: "invalid_config", message: scrub(error.message, secrets) };

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
  secrets: ReadonlyArray<string>,
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
    Effect.mapError((error) => invalidConfig(error, secrets)),
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
  const storedSecrets = secretSlots(stored).map((slot) => slot.value);
  const raw = yield* parseYaml(text, storedSecrets);

  const prepared = yield* Effect.try({
    try: () => prepareDocument(raw),
    catch: (error) =>
      invalidConfig(
        error instanceof ConfigValidationError
          ? error
          : new ConfigValidationError({ message: String(error) }),
        storedSecrets,
      ),
  });

  const secrets = [...storedSecrets, ...secretSlots(prepared).map((slot) => slot.value)];

  // Validated before the secrets are restored: a schema message may quote a value, and here it can only be a
  // placeholder or what the caller typed.
  yield* decodeConfig(prepared).pipe(Effect.mapError((error) => invalidConfig(error, secrets)));
  const restored = restoreSecrets(prepared, stored);

  if (!restored.ok) return yield* Effect.fail<RawProblem>(restored.problem);

  const config = yield* decodeConfig(restored.document).pipe(
    Effect.mapError((error) => invalidConfig(error, secrets)),
  );

  // SAFETY: the encoded config is a plain JSON object (the schema's encoded side only holds JSON values).
  const canonical = encodeConfig(config) as JsonObject;

  // The review decodes the edit again with unguessable stand-ins for the restored secrets, so it tells kept from new
  // secrets (and what was dropped) by origin: nothing in it depends on whether a typed value equals a stored secret.
  const tags = secretTags(`t${crypto.randomUUID().replaceAll("-", "")}`);
  const tagged = restoreSecrets(prepared, stored, tags.standIn);

  if (!tagged.ok) return yield* Effect.fail<RawProblem>(tagged.problem);

  const taggedConfig = yield* decodeConfig(tagged.document).pipe(
    Effect.mapError((error) => invalidConfig(error, secrets)),
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
    dropped: yield* sharedDropped(prepared, stored, restored.restored, tags, secrets).pipe(
      Effect.map((dropped) => dropped ?? droppedPaths(tagged.document, taggedCanonical)),
    ),
    notApplied: notAppliedSettings(config),
  };
});
