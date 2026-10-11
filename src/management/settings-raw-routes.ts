/**
 * `GET|PUT /v8/management/settings/config` and `POST /v8/management/settings/config/check` (`SettingsGroup` `raw`,
 * `checkRaw`, `saveRaw` in contract/settings.ts): the control panel's raw configuration editor.
 *
 * Workers addition, no Go counterpart (Go's panel reads and writes `config.yaml` with raw secrets). `GET /config*`
 * mask the same way (`config-routes.ts`) but cannot restore placeholders on write, so this is the one lossless round
 * trip of a masked document. The editor gets the stored document as sparse YAML with every secret masked as
 * `[redacted#n]…abcd` (`config-secrets.ts`) and sends `{version, yaml}` back:
 *
 * - a stale `version` is `409 conflict` before anything else (placeholders are numbered per version), no retry;
 * - the text is read by `settings-raw.ts` `readRawEdit` (YAML `422 invalid_yaml` with `line`/`column`, config
 *   `422 invalid_config` with `path` when known, placeholders that cannot be restored `422` with their `path`);
 * - the admin lock-out guard of `PATCH /settings` applies to the whole document;
 * - `check` stores nothing and answers the masked canonical result (new secrets as `[new secret]…`), what is dropped,
 *   what has no effect on Workers and `moved_secrets` (kept secrets now sent to another family or host, also in the
 *   `PUT` reply); `PUT` stores with `putConfig(text, version)`. A document whose canonical form
 *   equals the stored one is not written: the reply keeps the current `version` (no spurious version bump, so other
 *   open pages do not get a `409`).
 *
 * Bodies above 512 KiB are `413 body_too_large`, counted while the stream is read (chunked bodies included).
 */
import { Effect, Schema } from "effect";
import { HttpRouter } from "effect/http";
import { AccessPrincipal } from "../access/principal.ts";
import { isJsonObject, type Json, jsonEquals } from "../json/index.ts";
import { maskDocument } from "./config-secrets.ts";
import { RawConfigInput } from "./contract/settings.ts";
import { boundedBodyText, controlPlane, handled, jsonReply, replyError } from "./http.ts";
import { checkDocumentLockout } from "./settings.ts";
import { maskedYaml, type RawEdit, readRawEdit } from "./settings-raw.ts";
import { alwaysAdmin, storedConfig } from "./settings-routes.ts";

const PATH = "/v8/management/settings/config";

/** Largest accepted request body (the YAML inside a JSON body). */
const MAX_BODY_BYTES = 512 * 1024;

const view = Effect.gen(function* () {
  const current = yield* storedConfig;
  const masked = maskDocument(current.document);

  return jsonReply(200, {
    version: current.version,
    yaml: maskedYaml(masked.document),
    secrets: masked.secrets,
  });
});

const invalidBody = () => replyError(400, "invalid body");

const decodeInput = Schema.decodeUnknownEffect(RawConfigInput);

/** The edit in the body, read against the stored document of the version it names. */
const edit = Effect.gen(function* () {
  const text = yield* boundedBodyText(MAX_BODY_BYTES);

  const body = yield* Effect.try({
    // SAFETY: JSON.parse always returns a JSON value, so naming it Json only records that.
    try: () => JSON.parse(text) as Json,
    catch: invalidBody,
  });

  if (!isJsonObject(body)) return yield* invalidBody();
  const input = yield* decodeInput(body).pipe(Effect.mapError(invalidBody));
  const current = yield* storedConfig;

  if (current.version !== input.version)
    return yield* replyError(409, "conflict", {
      message: `config changed since version ${input.version} (now ${current.version})`,
    });

  const read: RawEdit = yield* readRawEdit(input.yaml, current.document).pipe(
    Effect.mapError((problem) => replyError(422, problem.error, { ...problem })),
  );

  const identity = yield* AccessPrincipal;

  const lockout = checkDocumentLockout({
    before: current.config,
    after: read.config,
    principal: identity.principal,
    alwaysAdmin: yield* alwaysAdmin,
  });

  if (lockout !== undefined)
    return yield* replyError(lockout.status, lockout.error, {
      message: lockout.message,
      path: lockout.path,
    });

  return { current, read };
});

const check = Effect.gen(function* () {
  const { read } = yield* edit;

  return jsonReply(200, {
    yaml: maskedYaml(read.review.document),
    dropped: read.dropped,
    not_applied: read.notApplied,
    kept_secrets: read.review.kept,
    new_secrets: read.review.fresh,
    moved_secrets: read.review.moved,
  });
});

const save = Effect.gen(function* () {
  const { current, read } = yield* edit;

  const saved = (version: number) =>
    jsonReply(200, {
      status: "ok",
      version,
      dropped: read.dropped,
      not_applied: read.notApplied,
      moved_secrets: read.review.moved,
    });

  if (jsonEquals(read.canonical, current.document)) return saved(current.version);

  const result = yield* controlPlane("putConfig", (stub) =>
    stub.putConfig(JSON.stringify(read.document), current.version),
  );

  if (result.ok) {
    if (result.notApplied.length > 0) {
      yield* Effect.logWarning("config keys not applied on Workers (see MIGRATION.md)").pipe(
        Effect.annotateLogs({ keys: result.notApplied.join(", ") }),
      );
    }

    return saved(result.version);
  }

  if (result.error === "conflict")
    return yield* replyError(409, "conflict", { message: result.message });

  // Not expected (the same document was just decoded); the codec's message is value-free (`config/codec.ts`).
  return yield* replyError(422, "invalid_config", { message: result.message });
});

export const settingsRawRoutes = [
  HttpRouter.route("GET", PATH, handled(view)),
  HttpRouter.route("PUT", PATH, handled(save)),
  HttpRouter.route("POST", `${PATH}/check`, handled(check)),
];
