/**
 * Config documents <-> `Config`: YAML/JSON import, validation, normalisation and export.
 *
 * Go source: internal/config/config_load.go (LoadConfig) and config_v8.go (YAML boundary). Unlike Go, no file is
 * ever rewritten: the canonical form is the JSON document stored in the ControlPlane Durable Object.
 */
import { Effect, Schema, SchemaIssue } from "effect";
import { parse, stringify } from "yaml";
import {
  isJsonArray,
  isJsonObject,
  jsonEquals,
  type Json,
  type JsonObject,
} from "../json/index.ts";
import { ConfigValidationError, configPath } from "./errors.ts";
import { normalizeConfig } from "./normalize.ts";
import { prepareDocument } from "./document.ts";
import { Config, type ConfigEncoded } from "./schema.ts";

const decodeSchema = Schema.decodeUnknownEffect(Config);

const encodeSchema = Schema.encodeSync(Config);

const issuePaths = SchemaIssue.makeFormatterStandardSchemaV1();

/**
 * Validates a raw document (parsed YAML or JSON; v8 or legacy layout) and returns the normalised `Config`.
 * Unknown keys and keys that do not apply on Workers are dropped.
 */
export const decodeConfig = (raw: Json): Effect.Effect<Config, ConfigValidationError> =>
  Effect.gen(function* () {
    const prepared = yield* Effect.try({
      try: () => prepareDocument(raw),
      catch: (error) =>
        error instanceof ConfigValidationError
          ? error
          : new ConfigValidationError({ message: String(error) }),
    });

    const decoded = yield* decodeSchema(prepared).pipe(
      Effect.mapError((error) => {
        const path = issuePaths(error.issue).issues[0]?.path;

        return new ConfigValidationError({
          message: error.message,
          ...(path === undefined || path.length === 0
            ? {}
            : {
                path: configPath(
                  path.map((segment) => (typeof segment === "object" ? segment.key : segment)),
                ),
              }),
        });
      }),
    );

    return normalizeConfig(decoded);
  });

/** Parses YAML (or JSON) text into a `Config`. An empty document yields the defaults. */
export const parseConfigYaml = (text: string): Effect.Effect<Config, ConfigValidationError> =>
  Effect.gen(function* () {
    const raw = yield* Effect.try({
      try: (): Json => (text.trim() === "" ? {} : parse(text)),
      catch: (error) =>
        new ConfigValidationError({
          message: `invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
        }),
    });

    return yield* decodeConfig(raw ?? {});
  });

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

export interface YamlExportOptions {
  /** Emit every field, including defaults (default: only non-default values). */
  readonly includeDefaults?: boolean;
}

/** Serialises `config` as v8 YAML. */
export const stringifyConfigYaml = (config: Config, options: YamlExportOptions = {}): string => {
  // SAFETY: the encoded config is a plain JSON document (the schema's encoded side only holds JSON values).
  const encoded = encodeConfig(config) as Json;
  const document = options.includeDefaults === true ? encoded : sparseDocument(encoded);

  return stringify(document, { lineWidth: 0 });
};
