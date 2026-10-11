/**
 * `/v8/management/config`, `/config.yaml` and `/config/*path`.
 *
 * Go source: internal/api/handlers/management/config_v8.go (`ConfigV8`), server_management_v8.go (route table). The
 * document is the ControlPlane's canonical config (all defaults included); `config.yaml` is the sparse YAML export.
 * Writes are read-modify-write with the stored version as `expectedVersion` (retried on a concurrent write), and the
 * ControlPlane validates and normalises the result: invalid documents answer `422 invalid_config`.
 *
 * Differences: a Workers addition for stale clients (the panel's rule editors replace whole lists). GETs answer
 * `ETag: "<version>"`; a write with `If-Match: "<version>"` (or the bare number) is one attempt against exactly that
 * version: a changed config answers `409 conflict` and nothing is stored, a malformed header `400 invalid_if_match`.
 * Every ok reply carries the stored `version`. Without `If-Match` the behaviour is Go's (retry on interleaving).
 */
import { Effect, Match, Result } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { parseConfigYaml, stringifyConfigYaml } from "../config/codec.ts";
import { decodeStoredConfig } from "../config/store.ts";
import { isJsonObject, type Json, type JsonObject } from "../json/index.ts";
import {
  deleteAtPath,
  getAtPath,
  injectAuthIndexes,
  parseConfigPath,
  stripAuthIndexes,
  writeAtPath,
} from "./config-document.ts";
import { bodyText, controlPlane, handled, jsonReply, Reply, replyError } from "./http.ts";

const PREFIX = "/v8/management/config";

const MAX_ATTEMPTS = 4;

const pathRemainder = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;

  return new URL(request.originalUrl, "http://localhost").pathname.slice(PREFIX.length);
});

const storedDocument = Effect.gen(function* () {
  const wire = yield* controlPlane("getConfig", (stub) => stub.getConfig());
  const text = wire.document ?? "{}";

  // SAFETY: the stored config document is always a serialized JSON object (writes reject non-objects).
  return { version: wire.version, text, document: JSON.parse(text) as JsonObject };
});

const decodeConfig = (text: string) =>
  decodeStoredConfig(text).pipe(Effect.mapError(() => replyError(500, "invalid_config")));

const readPath = (rest: string) => {
  const parts = parseConfigPath(rest);

  return parts === undefined ? Effect.fail(replyError(400, "invalid_path")) : Effect.succeed(parts);
};

const okReply = (version: number) => jsonReply(200, { status: "ok", "config-version": 8, version });

/**
 * The version a write is conditional on (`If-Match`): `"12"`, `W/"12"` or `12`. Absent or `*` = unconditional;
 * anything else is a malformed header.
 */
const ifMatch = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const raw = request.headers["if-match"]?.trim();

  if (raw === undefined || raw === "" || raw === "*") return undefined;
  const match = /^(?:W\/)?(?:"(\d{1,15})"|(\d{1,15}))$/.exec(raw);
  const digits = match?.[1] ?? match?.[2];

  if (digits === undefined) return yield* replyError(400, "invalid_if_match");

  return Number(digits);
});

type StoreOutcome = { readonly saved: number } | "conflict";

/** Stores `text`; `conflict` is reported to the caller so read-modify-write loops can retry. */
const store = (text: string, expectedVersion: number | undefined) =>
  controlPlane("putConfig", (stub) => stub.putConfig(text, expectedVersion)).pipe(
    Effect.flatMap((result): Effect.Effect<StoreOutcome, Reply> => {
      if (result.ok) {
        // Go config files often carry keys that do nothing on Workers; say so instead of silently ignoring them.
        const { notApplied } = result;

        const saved: StoreOutcome = { saved: result.version };

        return notApplied.length === 0
          ? Effect.succeed(saved)
          : Effect.logWarning("config keys not applied on Workers (see MIGRATION.md)").pipe(
              Effect.annotateLogs({ keys: notApplied.join(", ") }),
              Effect.as(saved),
            );
      }

      if (result.error === "conflict") return Effect.succeed("conflict" as const);

      return Effect.fail(replyError(422, "invalid_config", { message: result.message }));
    }),
  );

const conflict = replyError(409, "conflict", { message: "config changed concurrently, retry" });

const conflictFor = (expected: number | undefined) => (expected === undefined ? conflict : stale);

const etag = (version: number) => ({ etag: `"${version}"` });

const stale = replyError(409, "conflict", {
  message: "config changed since the version in If-Match",
});

/**
 * Read-modify-write of the document (`edit` returns a reply to abort, or the new document). With `expected` (the
 * request's `If-Match`) there is one attempt against that version; otherwise a concurrent write is retried.
 */
const modify = (edit: (document: JsonObject) => JsonObject | Reply, expected: number | undefined) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < (expected === undefined ? MAX_ATTEMPTS : 1); attempt += 1) {
      const current = yield* storedDocument;

      // A stale view answers 409 before the edit can fail with its own (misleading) 404.
      if (expected !== undefined && expected !== current.version) return yield* stale;
      const edited = edit(current.document);

      if (edited instanceof Reply) return yield* edited;
      const outcome = yield* store(JSON.stringify(stripAuthIndexes(edited)), current.version);

      if (outcome !== "conflict") return okReply(outcome.saved);
    }

    return yield* conflictFor(expected);
  });

const getConfig = (yaml: boolean) =>
  Effect.gen(function* () {
    const rest = yaml ? "" : yield* pathRemainder;
    const parts = yield* readPath(rest);
    const current = yield* storedDocument;

    if (yaml) {
      const config = yield* decodeConfig(current.text);

      return HttpServerResponse.text(stringifyConfigYaml(config), {
        contentType: "application/yaml; charset=utf-8",
        headers: etag(current.version),
      });
    }

    const config = yield* decodeConfig(current.text);
    const document = injectAuthIndexes(current.document, config);
    const value = getAtPath(document, parts);

    if (value === undefined) return yield* replyError(404, "not_found");

    return HttpServerResponse.setHeaders(jsonReply(200, value), etag(current.version));
  });

/** Parses a JSON request body (`invalid_json` when the text is not valid JSON). */
const jsonValue = Effect.gen(function* () {
  const text = yield* bodyText;

  return yield* Effect.try({
    // SAFETY: JSON.parse always returns a JSON value, so naming it Json only records that.
    try: () => JSON.parse(text) as Json,
    catch: () => replyError(400, "invalid_json"),
  });
});

const writeConfig = (mode: "put" | "patch", yaml: boolean) =>
  Effect.gen(function* () {
    const expected = yield* ifMatch;

    if (yaml) {
      const text = yield* bodyText;
      // Validate before storing so a malformed document answers the same way as a bad JSON write.
      const parsed = yield* Effect.result(parseConfigYaml(text));

      if (Result.isFailure(parsed))
        return yield* replyError(422, "invalid_config", { message: parsed.failure.message });
      const outcome = yield* store(text, expected);

      return outcome === "conflict" ? yield* conflictFor(expected) : okReply(outcome.saved);
    }

    const parts = yield* readPath(yield* pathRemainder);
    const value = yield* jsonValue;

    if (parts.length === 0 && !isJsonObject(value))
      return yield* replyError(400, "config_must_be_object");

    if (parts.length === 0 && mode === "put") {
      const outcome = yield* store(
        // SAFETY: the branch above returned unless value is a JSON object when parts is empty.
        JSON.stringify(stripAuthIndexes(value as JsonObject)),
        expected,
      );

      return outcome === "conflict" ? yield* conflictFor(expected) : okReply(outcome.saved);
    }

    return yield* modify((document) => {
      const written = writeAtPath(document, parts, value, mode);

      return written === "invalid_path" ? replyError(400, "invalid_path") : written;
    }, expected);
  });

const deleteConfig = Effect.gen(function* () {
  const parts = yield* readPath(yield* pathRemainder);

  if (parts.length === 0) return yield* replyError(400, "cannot_delete_config");
  const expected = yield* ifMatch;

  return yield* modify(
    (document) => deleteAtPath(document, parts) ?? replyError(404, "not_found"),
    expected,
  );
});

const routes = (
  path: `/${string}`,
  yaml: boolean,
  methods: ReadonlyArray<"GET" | "PUT" | "PATCH" | "DELETE">,
) =>
  methods.map((method) => {
    const handler = Match.value(method).pipe(
      Match.when("GET", () => getConfig(yaml)),
      Match.when("PUT", () => writeConfig("put", yaml)),
      Match.when("PATCH", () => writeConfig("patch", yaml)),
      Match.when("DELETE", () => deleteConfig),
      Match.exhaustive,
    );

    return HttpRouter.route(method, path, handled(handler));
  });

// A `/*` route also answers its bare prefix (`/config`), so one route per method family covers whole-document and
// path-addressed access.
export const configRoutes = [
  ...routes(`${PREFIX}.yaml`, true, ["GET", "PUT"]),
  ...routes(`${PREFIX}/*`, false, ["GET", "PUT", "PATCH", "DELETE"]),
];
