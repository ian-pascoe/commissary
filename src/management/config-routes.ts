/**
 * `/v8/management/config`, `/config.yaml` and `/config/*path`.
 *
 * Go source: internal/api/handlers/management/config_v8.go (`ConfigV8`), server_management_v8.go (route table). The
 * document is the ControlPlane's canonical config (all defaults included); `config.yaml` is the sparse YAML export.
 * Writes are read-modify-write with the stored version as `expectedVersion` (retried on a concurrent write), and the
 * ControlPlane validates and normalises the result: invalid documents answer `422 invalid_config`.
 *
 * Differences:
 *
 * - A Workers addition for stale clients (the panel's rule editors replace whole lists). GETs answer
 *   `ETag: "<version>"`; a write with `If-Match: "<version>"` (or the bare number) is one attempt against exactly
 *   that version: a changed config answers `409 conflict` and nothing is stored, a malformed header
 *   `400 invalid_if_match`. Every ok reply carries the stored `version`. Without `If-Match` the behaviour is Go's
 *   (retry on interleaving).
 * - Every read is masked (Go serves secrets in the clear): `GET /config`, `/config/<path>` and `/config.yaml` show each
 *   secret as `[redacted#n]…abcd` (`config-secrets.ts` `maskDocument`, numbered over the whole document of the
 *   version, so the numbers are those of `GET /settings/config`; `config.yaml` is the same masked YAML). Lossless
 *   round trips go through the version-pinned raw editor (`PUT /settings/config`), which restores placeholders.
 * - Writes restore nothing: a string carrying a placeholder marker (`[redacted…`, `[new secret]`, any case) at a
 *   secret position is `422 masked_value` with its `path`, and nothing is stored. Elsewhere it is
 *   `422 masked_value_outside_secret_field` (the raw editor's code), because the raw editor refuses markers outside
 *   secret fields: one stored there would block every later `PUT /settings/config`. A marker the stored document
 *   already holds at the same path is let through (written before this guard; refusing it would block every write).
 *   Paths are those of the v8 layout: a placeholder in a legacy-layout `PUT /config.yaml` (`claude-api-key`, ...) is
 *   reported where the import moves it (`api-keys.claude[0]...`). Plain new secrets are stored as sent (a Go config
 *   import keeps working).
 * - No `auth_index` on `GET /config` (Go adds one per config key for its panel's `api-call`; that panel is gone).
 *   Writes still strip it, as Go does.
 * - Config error messages never quote a value (`config/codec.ts`: a YAML error is a fixed sentence per error code
 *   with `line` and `column`, a schema error its expectation and `path`); they name at most keys of the written
 *   document, and are passed on unscrubbed, so a refused write reads the same whether a typed value or key equals a
 *   stored secret or not.
 * - `access.admin-service-tokens` can only be changed by a service-token administrator or a platform admin
 *   (`PLATFORM_ADMIN_*`): an email admin who changes it, by any write, gets `403 service_tokens_require_service_admin`
 *   and nothing is stored (`settings.ts` `checkServiceTokenAdmins`, the same rule as `PATCH /settings` and
 *   `PUT /settings/config`).
 * - Path segments `__proto__`, `constructor` and `prototype` are `400 invalid_path` (Go treats them as map keys). The
 *   path is read from the URL as the router matched it (`config-document.ts` `configPathOfUrl`).
 */
import { Effect, Match, Result } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { parse } from "yaml";
import { AccessPrincipal } from "../access/principal.ts";
import { decodeConfig, parseConfigYaml } from "../config/codec.ts";
import { prepareDocument } from "../config/document.ts";
import type { ConfigValidationError } from "../config/errors.ts";
import { isJsonObject, type Json, type JsonObject } from "../json/index.ts";
import {
  configPathOfUrl,
  deleteAtPath,
  getAtPath,
  parseConfigPath,
  stripAuthIndexes,
  writeAtPath,
} from "./config-document.ts";
import type { WorkerEnv } from "../platform/env.ts";
import { keepStoredKeys, typedKeysAt } from "./key-duplicates.ts";
import { maskDocument, type MaskedValue, maskedValueAt } from "./config-secrets.ts";
import { bodyText, controlPlane, handled, jsonReply, Reply, replyError } from "./http.ts";
import { checkServiceTokenAdmins } from "./settings.ts";
import { maskedYaml } from "./settings-raw.ts";
import { alwaysAdmin } from "./settings-routes.ts";

const PREFIX = "/v8/management/config";

const MAX_ATTEMPTS = 4;

/**
 * The path after `/config`, read like the router matched the URL (`//v8/…`, `%63onfig` and case included): from `url`,
 * which has the org of an org-scoped request taken out (`access/org-address.ts`), not from `originalUrl`.
 */
const pathRemainder = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const rest = configPathOfUrl(request.url);

  return rest === undefined ? yield* replyError(400, "invalid_path") : rest;
});

const storedDocument = Effect.gen(function* () {
  const wire = yield* controlPlane("getConfig", (stub) => stub.getConfig());
  const text = wire.document ?? "{}";

  // SAFETY: the stored config document is always a serialized JSON object (writes reject non-objects).
  return { version: wire.version, document: JSON.parse(text) as JsonObject };
});

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

// --- write checks ----------------------------------------------------------------------------------------------

/** `raw` in the v8 layout when it can be prepared (legacy layouts are moved), else as is. */
const preparedOf = (raw: Json): Json => {
  try {
    return prepareDocument(raw);
  } catch {
    return raw;
  }
};

/** YAML (or JSON) text as the codec reads it; `{}` when it does not parse (the decode then reports why). */
const rawOf = (text: string): Json => {
  try {
    const parsed: Json | null | undefined = text.trim() === "" ? {} : parse(text);

    return parsed ?? {};
  } catch {
    return {};
  }
};

const maskedValue = (found: MaskedValue) =>
  found.secret
    ? replyError(422, "masked_value", {
        path: found.path,
        message:
          "a masked placeholder cannot be stored as a secret; edit secrets through PUT /v8/management/settings/config, which restores them",
      })
    : // The raw editor's code for the same refusal: it would refuse this document too.
      replyError(422, "masked_value_outside_secret_field", {
        path: found.path,
        message:
          "masked placeholder text cannot be stored; edit the configuration through PUT /v8/management/settings/config",
      });

/** A config the codec refused: its value-free message and where, when known. */
const invalidConfig = (error: ConfigValidationError) =>
  replyError(422, "invalid_config", {
    message: error.message,
    ...(error.path === undefined ? {} : { path: error.path }),
    ...(error.line === undefined ? {} : { line: error.line }),
    ...(error.column === undefined ? {} : { column: error.column }),
  });

/**
 * Checks what a write would store (`text`, YAML or JSON, parsed as `raw`) against the stored document: a placeholder
 * marker is `422 masked_value` (`masked_value_outside_secret_field` outside secret positions; paths of the v8
 * layout, also for a legacy-layout document), an invalid config `422 invalid_config` (value-free message).
 */
const checkWrite = Effect.fnUntraced(function* (
  text: string,
  raw: Json,
  stored: JsonObject,
): Effect.fn.Return<
  void,
  Reply,
  AccessPrincipal | WorkerEnv | HttpServerRequest.HttpServerRequest
> {
  const prepared = preparedOf(raw);
  const masked = isJsonObject(prepared) ? maskedValueAt(prepared, stored) : undefined;

  if (masked !== undefined) return yield* maskedValue(masked);
  const parsed = yield* Effect.result(parseConfigYaml(text));

  if (Result.isFailure(parsed)) return yield* invalidConfig(parsed.failure);
  const { principal } = yield* AccessPrincipal;
  const always = yield* alwaysAdmin;

  if (always || principal.kind === "service") return;

  // The stored document decoded as the ControlPlane does, to tell whether the admin service tokens change.
  const before = yield* decodeConfig(stored).pipe(
    Effect.mapError(() => replyError(500, "invalid_config")),
  );

  const refused = checkServiceTokenAdmins({
    before,
    after: parsed.success,
    principal,
    alwaysAdmin: always,
  });

  if (refused !== undefined)
    return yield* replyError(refused.status, refused.error, {
      message: refused.message,
      path: refused.path,
    });
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

      // The codec's value-free message (`config/codec.ts`).
      return Effect.fail(replyError(422, "invalid_config", { message: result.message }));
    }),
  );

const conflict = replyError(409, "conflict", { message: "config changed concurrently, retry" });

const conflictFor = (expected: number | undefined) => (expected === undefined ? conflict : stale);

const etag = (version: number) => ({ etag: `"${version}"` });

const stale = replyError(409, "conflict", {
  message: "config changed since the version in If-Match",
});

/** Checks and stores a whole document (`text`, parsed as `raw`): one attempt, conditional on `expected` if set. */
const storeWhole = Effect.fnUntraced(function* (
  text: string,
  raw: Json,
  expected: number | undefined,
) {
  const current = yield* storedDocument;
  yield* checkWrite(text, raw, current.document);
  const outcome = yield* store(text, expected);

  return outcome === "conflict" ? yield* conflictFor(expected) : okReply(outcome.saved);
});

/**
 * Read-modify-write of the document (`edit` returns a reply to abort, or the new document). With `expected` (the
 * request's `If-Match`) there is one attempt against that version; otherwise a concurrent write is retried.
 */
const modify = (
  edit: (document: JsonObject) => JsonObject | Reply,
  expected: number | undefined,
  written: ReadonlyArray<string> | undefined,
) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < (expected === undefined ? MAX_ATTEMPTS : 1); attempt += 1) {
      const current = yield* storedDocument;

      // A stale view answers 409 before the edit can fail with its own (misleading) 404.
      if (expected !== undefined && expected !== current.version) return yield* stale;
      const edited = edit(current.document);

      if (edited instanceof Reply) return yield* edited;
      const stripped = stripAuthIndexes(edited);

      // Stored keys win over the ones this write put in (`key-duplicates.ts`); a delete puts none in.
      const document =
        written === undefined
          ? stripped
          : yield* keepStoredKeys(stripped, (family) => typedKeysAt(stripped, family, written));

      const text = JSON.stringify(document);
      yield* checkWrite(text, document, current.document);
      const outcome = yield* store(text, current.version);

      if (outcome !== "conflict") return okReply(outcome.saved);
    }

    return yield* conflictFor(expected);
  });

// --- handlers --------------------------------------------------------------------------------------------------

const getConfig = (yaml: boolean) =>
  Effect.gen(function* () {
    const rest = yaml ? "" : yield* pathRemainder;
    const parts = yield* readPath(rest);
    const current = yield* storedDocument;
    // Numbered over the whole document, so a subtree read shows the same `[redacted#n]` as the full one.
    const masked = maskDocument(current.document).document;

    if (yaml)
      return HttpServerResponse.text(maskedYaml(masked), {
        contentType: "application/yaml; charset=utf-8",
        headers: etag(current.version),
      });

    const value = getAtPath(masked, parts);

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

      return yield* storeWhole(text, rawOf(text), expected);
    }

    const parts = yield* readPath(yield* pathRemainder);
    const value = yield* jsonValue;

    if (parts.length === 0 && !isJsonObject(value))
      return yield* replyError(400, "config_must_be_object");

    if (parts.length === 0 && mode === "put") {
      // SAFETY: the branch above returned unless value is a JSON object when parts is empty.
      const document = stripAuthIndexes(value as JsonObject);

      return yield* storeWhole(JSON.stringify(document), document, expected);
    }

    return yield* modify(
      (document) => {
        const written = writeAtPath(document, parts, value, mode);

        return written === "invalid_path" ? replyError(400, "invalid_path") : written;
      },
      expected,
      parts,
    );
  });

const deleteConfig = Effect.gen(function* () {
  const parts = yield* readPath(yield* pathRemainder);

  if (parts.length === 0) return yield* replyError(400, "cannot_delete_config");
  const expected = yield* ifMatch;

  return yield* modify(
    (document) => deleteAtPath(document, parts) ?? replyError(404, "not_found"),
    expected,
    undefined,
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
