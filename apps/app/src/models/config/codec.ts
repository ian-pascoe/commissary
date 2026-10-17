/**
 * Config documents <-> `Config`: YAML/JSON import, validation, normalisation and the canonical/sparse JSON documents.
 *
 * Go source: internal/config/config_load.go (LoadConfig) and config_v8.go (YAML boundary). Unlike Go, no file is
 * ever rewritten: the config is stored as config entries in the ControlPlane Durable Object (`store.ts`), which
 * assemble a canonical JSON document.
 *
 * Error messages never quote a value of the document (Workers addition): a YAML error is a fixed sentence per error
 * code (`yaml-message.ts`) with its line and column, a schema issue its expectation and path, never the offending
 * value. Paths (and the `api-keys` family or group field `document.ts` names) are keys the caller wrote, so a
 * refused write reads the same whether a typed value or key equals a stored secret or not; the messages are not
 * scrubbed of stored secrets (that would tell the two apart).
 */
import { Effect, Match, Predicate, Schema, SchemaIssue } from "effect";
import { LineCounter, parseDocument } from "yaml";
import {
  isJsonArray,
  isJsonObject,
  jsonEquals,
  type Json,
  type JsonObject,
} from "@commissary/json";
import { ConfigValidationError, configPath } from "./errors.ts";
import { normalizeConfig } from "./normalize.ts";
import { prepareDocument } from "./document.ts";
import { Config, type ConfigEncoded, isOpenCodeProtocol, OPENCODE_PROTOCOLS } from "./schema.ts";
import { yamlMessage } from "./yaml-message.ts";

const decodeSchema = Schema.decodeUnknownEffect(Config);

const encodeSchema = Schema.encodeSync(Config);

interface IssueEntry {
  readonly path: ReadonlyArray<PropertyKey>;
  readonly message: string;
}

/** `Expected <annotation>` when the schema names what it expects, else `fallback`. */
const expectation = (
  annotations: { readonly expected?: unknown } | undefined,
  fallback: string,
): string => {
  const expected = annotations?.expected;

  return typeof expected === "string" ? `Expected ${expected}` : fallback;
};

/**
 * The issues of a failed decode, flattened like `makeFormatterStandardSchemaV1` but never with the input (its
 * `got <input>` and custom messages can quote a value): the expectation, else the kind of issue.
 */
const issueEntries = (
  issue: SchemaIssue.Issue,
  path: ReadonlyArray<PropertyKey>,
): ReadonlyArray<IssueEntry> =>
  Match.value(issue).pipe(
    Match.tagsExhaustive({
      Filter: (filter): ReadonlyArray<IssueEntry> =>
        Predicate.isTagged(filter.issue, "InvalidValue")
          ? [{ path, message: expectation(filter.filter.annotations, "Invalid value") }]
          : issueEntries(filter.issue, path),
      Encoding: (encoding) => issueEntries(encoding.issue, path),
      Pointer: (pointer) => issueEntries(pointer.issue, [...path, ...pointer.path]),
      Composite: (composite) => composite.issues.flatMap((inner) => issueEntries(inner, path)),
      AnyOf: (anyOf) =>
        anyOf.issues.length === 0
          ? [{ path, message: "Expected one of the allowed values" }]
          : anyOf.issues.flatMap((inner) => issueEntries(inner, path)),
      // `Expected <type>`; the stock message adds `, got <input>` only when the input is attached.
      InvalidType: (invalid) => [
        {
          path,
          message: SchemaIssue.hasInput(invalid)
            ? "Invalid type"
            : SchemaIssue.defaultLeafHook(invalid),
        },
      ],
      InvalidValue: (invalid) => [
        { path, message: expectation(invalid.annotations, "Invalid value") },
      ],
      MissingKey: () => [{ path, message: "Missing key" }],
      UnexpectedKey: () => [{ path, message: "Unexpected key" }],
      Forbidden: () => [{ path, message: "Forbidden operation" }],
      OneOf: () => [{ path, message: "Expected exactly one member to match" }],
    }),
  );

/**
 * The first model `protocol` of the OpenCode sections that is not a known protocol (Workers addition: the schema
 * accepts any string so other providers can carry a stray value, which the normaliser drops).
 */
const unknownOpenCodeProtocol = (config: Config): ConfigValidationError | undefined => {
  for (const family of ["opencode-zen", "opencode-go"] as const) {
    for (const [g, group] of config["api-keys"][family].entries()) {
      const lists = [
        { path: [g, "models"], models: group.models },
        ...group.keys.map((key, k) => ({ path: [g, "keys", k, "models"], models: key.models })),
      ];

      for (const { path, models } of lists) {
        for (const [m, model] of (models ?? []).entries()) {
          if (model.protocol === undefined || isOpenCodeProtocol(model.protocol)) continue;
          const at = configPath(["api-keys", family, ...path, m, "protocol"]);

          return new ConfigValidationError({
            message: `Expected one of ${OPENCODE_PROTOCOLS.map((p) => `"${p}"`).join(", ")} at ${at}`,
            path: at,
          });
        }
      }
    }
  }

  return undefined;
};

const entryPath = (path: ReadonlyArray<PropertyKey>): string =>
  configPath(path.map((segment) => (typeof segment === "object" ? String(segment) : segment)));

/**
 * Validates a raw document (parsed YAML or JSON; v8 or legacy layout) and returns the `Config` as written, before
 * normalisation: groups and keys keep their place (nothing is deduplicated or dropped), which is what lets a caller
 * compare the document's own indexes with `keyIdentities`.
 */
export const decodeRawConfig = (raw: Json): Effect.Effect<Config, ConfigValidationError> =>
  Effect.gen(function* () {
    const prepared = yield* Effect.try({
      try: () => prepareDocument(raw),
      catch: (error) =>
        error instanceof ConfigValidationError
          ? error
          : new ConfigValidationError({ message: "invalid config document" }),
    });

    const decoded = yield* decodeSchema(prepared).pipe(
      Effect.mapError((error) => {
        const entries = issueEntries(error.issue, []);
        const path = entries[0]?.path;

        return new ConfigValidationError({
          message: entries
            .map((entry) =>
              entry.path.length === 0
                ? entry.message
                : `${entry.message} at ${entryPath(entry.path)}`,
            )
            .join("\n"),
          ...(path === undefined || path.length === 0 ? {} : { path: entryPath(path) }),
        });
      }),
    );

    const protocolError = unknownOpenCodeProtocol(decoded);

    if (protocolError !== undefined) return yield* protocolError;

    return decoded;
  });

/**
 * Validates a raw document (parsed YAML or JSON; v8 or legacy layout) and returns the normalised `Config`.
 * Unknown keys and keys that do not apply on Workers are dropped.
 */
export const decodeConfig = (raw: Json): Effect.Effect<Config, ConfigValidationError> =>
  Effect.map(decodeRawConfig(raw), normalizeConfig);

/**
 * YAML (or JSON) text as a JSON value (`{}` for an empty document); a syntax error is a value-free
 * `ConfigValidationError` with its line and column.
 */
export const parseYamlText = (text: string): Effect.Effect<Json, ConfigValidationError> =>
  Effect.suspend(() => {
    if (text.trim() === "") return Effect.succeed({});
    const lines = new LineCounter();
    const document = parseDocument(text, { lineCounter: lines, prettyErrors: false });
    const error = document.errors[0];

    if (error !== undefined) {
      const { line, col } = lines.linePos(error.pos[0]);

      return Effect.fail(
        new ConfigValidationError({
          message: `invalid YAML: ${yamlMessage(error)} (line ${line}, column ${col})`,
          line,
          column: col,
        }),
      );
    }

    return Effect.try({
      // SAFETY: the core schema yields JSON values only (plain objects, arrays, strings, numbers, booleans, null).
      try: () => (document.toJS() ?? {}) as Json,
      // Alias resolution errors name the alias (source text): only the kind is kept.
      catch: () => new ConfigValidationError({ message: "invalid YAML: unresolvable aliases" }),
    });
  });

/** Parses YAML (or JSON) text into a `Config`. An empty document yields the defaults. */
export const parseConfigYaml = (text: string): Effect.Effect<Config, ConfigValidationError> =>
  Effect.flatMap(parseYamlText(text), decodeConfig);

/** The JSON-compatible v8 document of `config` (all defaults included). */
export const encodeConfig = (config: Config): ConfigEncoded => encodeSchema(config);

let defaultsDocument: ConfigEncoded | undefined;

const defaults = (): ConfigEncoded =>
  (defaultsDocument ??= encodeSchema(Schema.decodeUnknownSync(Config)({})));

/** Recursively drops values that equal the corresponding default, so exported YAML only lists what was set. */
const omitDefaults = (value: Json, base: Json | undefined): Json | undefined => {
  if (base !== undefined && jsonEquals(value, base)) return undefined;

  if (isJsonObject(value)) {
    const out: Record<string, Json> = {};
    const baseObject = isJsonObject(base) ? base : {};

    for (const [key, child] of Object.entries(value)) {
      const kept = omitDefaults(child, baseObject[key]);

      if (kept !== undefined) out[key] = kept;
    }

    return out;
  }

  return isJsonArray(value) && value.length === 0 && base === undefined ? undefined : value;
};

/**
 * `document` (a v8 JSON document, e.g. a masked copy of the stored one) without the values that equal their
 * defaults, `config-version: 8` first: what the sparse YAML export lists.
 */
export const sparseDocument = (document: Json): JsonObject => {
  // SAFETY: the defaults document is encoded by the config schema, hence plain JSON.
  const sparse = omitDefaults(document, defaults() as Json);

  return Object.assign({ "config-version": 8 }, isJsonObject(sparse) ? sparse : {});
};
