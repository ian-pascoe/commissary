/**
 * The management API's error body: every handler answers failures as `{"error": "<message>"}` (Go's
 * `c.JSON(status, gin.H{"error": ...})`, see `replyError` in `@commissary/core`). Some add a human-readable `message`
 * (e.g. `422 invalid_config`) and, for a refused setting, the dotted config `path` it concerns; an imported config
 * document that is not valid YAML adds the `line` and `column` of the problem. Shared with the browser: imports
 * `effect` only.
 */
import { Schema } from "effect";
import { HttpApiSchema } from "effect/http-api";

export class ManagementError extends Schema.Error<ManagementError>("ManagementError")({
  error: Schema.String,
  message: Schema.optionalKey(Schema.String),
  /** Dotted config path the error is about (`routing.session-affinity-ttl`). */
  path: Schema.optionalKey(Schema.String),
  /** 1-based position of a YAML syntax error in the submitted text (`422 invalid_yaml`). */
  line: Schema.optionalKey(Schema.Int),
  column: Schema.optionalKey(Schema.Int),
  /** Org slugs the error is about (`409 sole_owner` of `DELETE /me`: the orgs to hand over first). */
  orgs: Schema.optionalKey(Schema.Array(Schema.String)),
}) {}

/** Statuses the management handlers answer with an error body; the client decodes each into `ManagementError`. */
const ERROR_STATUSES = [400, 401, 403, 404, 409, 413, 415, 422, 500, 502, 503] as const;

/** Error schemas of a management endpoint (one per status: the client picks a decoder by status code). */
export const managementErrors = ERROR_STATUSES.map((status) =>
  ManagementError.pipe(HttpApiSchema.status(status)),
);
