import { Schema } from "effect";

/** The config document (YAML or JSON) is malformed or fails validation; maps to HTTP 400 in management. */
export class ConfigValidationError extends Schema.TaggedError<ConfigValidationError>()(
  "ConfigValidationError",
  {
    message: Schema.String,
    /** Where a schema check failed (`configPath` spelling), when known. */
    path: Schema.optional(Schema.String),
  },
) {}

/** A document path as messages spell it: keys joined by `.`, list positions as `[n]` (`api-keys.claude[0].keys[1]`). */
export const configPath = (segments: ReadonlyArray<PropertyKey>): string =>
  segments.reduce<string>(
    (out, segment) =>
      typeof segment === "number"
        ? `${out}[${segment}]`
        : out === ""
          ? String(segment)
          : `${out}.${String(segment)}`,
    "",
  );

/** The ControlPlane Durable Object could not be reached or returned an unusable config snapshot. */
export class ConfigStoreError extends Schema.TaggedError<ConfigStoreError>()("ConfigStoreError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/** `putConfig` was called with a stale `expectedVersion`. */
export class ConfigVersionConflict extends Schema.TaggedError<ConfigVersionConflict>()(
  "ConfigVersionConflict",
  {
    message: Schema.String,
    currentVersion: Schema.Number,
  },
) {}
