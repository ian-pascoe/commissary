/**
 * Credential (auth file) management: list, upload, delete, download, models, status, fields, refresh, cooldown reset.
 *
 * Go source: internal/api/handlers/management/auth_files.go (`ListAuthFiles`, `GetAuthFileModels`),
 * auth_files_crud.go (`UploadAuthFile`, `DeleteAuthFile`, `DownloadAuthFile`), auth_files_fields.go
 * (`PatchAuthFileStatus`, `PatchAuthFileFields`), auth_files_refresh.go (`RefreshAuthFiles`), quota.go (`ResetQuota`).
 * Auth files live in the ControlPlane Durable Object instead of a directory; the credential `id` is the file name.
 * Differences: a field patch refused for its value answers `422 {error, path}` naming the field (Go: `400`), and the
 * list masks secret-looking header values (`field-patch.ts`, `credential-entry.ts`), and the download answers only
 * service-token administrators (`403 download_requires_service_token` for an email admin): the file carries the
 * access and refresh tokens, and a service token is the credential meant for automation (`docs/ACCESS.md`).
 *
 * The list also carries the config API keys whose provider reports quota with the key (OpenCode Go, `source:
 * "config"`, named by their `auth_index`; `credential-entry.ts`). File-only operations naming one of them (delete,
 * download, field edits, token refresh) answer `409 config_credential`: the key lives in the config and is edited on
 * the API keys page. Its models are listed by the same name.
 */
import { Clock, Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { AccessPrincipal } from "../access/principal.ts";
import { isJsonObject, type Json, type JsonObject } from "../json/index.ts";
import { ModelRegistry } from "../registry/service.ts";
import {
  bodyJson,
  bodyObject,
  bodyText,
  controlPlane,
  handled,
  jsonReply,
  queryParams,
  replyError,
} from "./http.ts";

const text = (value: Json | undefined): string => (typeof value === "string" ? value.trim() : "");

/** `isUnsafeAuthFileName`: empty names and anything with a path separator. */
const unsafeName = (name: string): boolean => name.trim() === "" || /[/\\]/.test(name);

// --- list ---------------------------------------------------------------------------------------------------------

interface Pagination {
  readonly page: number;
  readonly pageSize: number;
}

const DEFAULT_PAGE_SIZE = 50;

const positiveInteger = (raw: string): number | undefined => {
  const trimmed = raw.trim();

  if (!/^[+-]?\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);

  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
};

/** `parseAuthFilesPagination`: pagination is on when `page` or `page_size` is present. */
const parsePagination = (
  params: URLSearchParams,
): Pagination | undefined | "invalid_page" | "invalid_page_size" => {
  const page = params.get("page");
  const pageSize = params.get("page_size");

  if (page === null && pageSize === null) return undefined;
  const parsedPage = page === null ? 1 : positiveInteger(page);

  if (parsedPage === undefined) return "invalid_page";
  const parsedSize = pageSize === null ? DEFAULT_PAGE_SIZE : positiveInteger(pageSize);

  if (parsedSize === undefined) return "invalid_page_size";

  return { page: parsedPage, pageSize: parsedSize };
};

const entryName = (entry: JsonObject): string => text(entry.name);

/**
 * Fails with `409 config_credential` when `name` is a config API key's `auth_index` (the name the list gives it), so a
 * file-only operation says why it does not apply instead of answering "not found". Indexes are public: answering for
 * one confirms no key guess.
 */
const refuseConfigKey = (name: string) =>
  Effect.gen(function* () {
    const config = yield* controlPlane("isConfigKey", (stub) => stub.isConfigKey(name));

    if (config) {
      return yield* replyError(409, "config_credential", {
        message: "this account is a config API key: edit or remove it on the API keys page",
      });
    }
  });

const listCredentials = Effect.gen(function* () {
  const params = yield* queryParams;
  const pagination = parsePagination(params);

  if (pagination === "invalid_page")
    return yield* replyError(400, "page must be a positive integer");

  if (pagination === "invalid_page_size")
    return yield* replyError(400, "page_size must be a positive integer");
  const name = params.get("name")?.trim() ?? "";
  // Indexes are lower-case hex; match them case-insensitively like every other `auth_index` input.
  const authIndex = params.get("auth_index")?.trim().toLowerCase() ?? "";

  const entries = yield* controlPlane("listCredentialEntries", (stub) =>
    stub.listCredentialEntries(),
  );

  const now = yield* Clock.currentTimeMillis;

  const matching = entries
    .filter(
      (entry) =>
        (name === "" || entry.name === name || entry.id === name) &&
        (authIndex === "" || entry.auth_index === authIndex),
    )
    .toSorted((a, b) => {
      const left = entryName(a);
      const right = entryName(b);
      const folded = left.toLowerCase().localeCompare(right.toLowerCase());

      return folded !== 0 ? folded : left < right ? -1 : left > right ? 1 : 0;
    });

  const observedAt = new Date(now).toISOString();

  if (pagination === undefined) return jsonReply(200, { observed_at: observedAt, files: matching });

  const total = matching.length;
  const start = Math.min((pagination.page - 1) * pagination.pageSize, total);
  const end = Math.min(start + pagination.pageSize, total);

  return jsonReply(200, {
    observed_at: observedAt,
    files: matching.slice(start, end),
    total,
    page: pagination.page,
    page_size: pagination.pageSize,
    has_more: end < total,
  });
});

// --- upload ---------------------------------------------------------------------------------------------------------

interface Upload {
  readonly name: string;
  readonly content: string;
}

/** Stores one auth file; the error text is what the panel shows for that file. */
const storeUpload = (upload: Upload) =>
  Effect.gen(function* () {
    const name = upload.name.trim();

    if (!name.toLowerCase().endsWith(".json")) return "file must be .json";

    if (unsafeName(name)) return "invalid name";

    const result = yield* controlPlane("importAuthFile", (stub) =>
      stub.importAuthFile(name, upload.content),
    );

    return result.ok ? undefined : `invalid auth file: ${result.message}`;
  });

/** Files of a multipart form, ordered by field name like Go; `undefined` when the body is not multipart. */
const multipartUploads = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;

  if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("multipart/form-data"))
    return undefined;

  const web = yield* HttpServerRequest.toWeb(request).pipe(
    Effect.mapError(() => replyError(400, "invalid multipart form")),
  );

  const form = yield* Effect.tryPromise({
    try: async () => await web.formData(),
    catch: (cause) =>
      replyError(
        400,
        `invalid multipart form: ${cause instanceof Error ? cause.message : "unreadable"}`,
      ),
  });

  const uploads: Upload[] = [];
  const keys = [...new Set(form.keys())].toSorted();

  for (const key of keys) {
    for (const value of form.getAll(key)) {
      if (typeof value === "string") continue;
      const content = yield* Effect.promise(async () => await value.text());
      uploads.push({ name: value.name.split(/[/\\]/).pop() ?? "", content });
    }
  }

  return uploads;
});

const uploadCredentials = Effect.gen(function* () {
  const uploads = yield* multipartUploads;

  if (uploads !== undefined) {
    if (uploads.length === 0) return yield* replyError(400, "no files uploaded");
    const stored: string[] = [];
    const failed: JsonObject[] = [];

    for (const upload of uploads) {
      const error = yield* storeUpload(upload);

      if (error === undefined) stored.push(upload.name.trim());
      else failed.push({ name: upload.name, error });
    }

    if (uploads.length === 1) {
      return failed[0] === undefined
        ? jsonReply(200, { status: "ok" })
        : yield* replyError(400, text(failed[0].error));
    }

    if (failed.length > 0) {
      return jsonReply(207, { status: "partial", uploaded: stored.length, files: stored, failed });
    }

    return jsonReply(200, { status: "ok", uploaded: stored.length, files: stored });
  }

  const params = yield* queryParams;
  const name = params.get("name")?.trim() ?? "";

  if (unsafeName(name)) return yield* replyError(400, "invalid name");

  if (!name.toLowerCase().endsWith(".json"))
    return yield* replyError(400, "name must end with .json");
  const content = yield* bodyText;
  const error = yield* storeUpload({ name, content });

  return error === undefined ? jsonReply(200, { status: "ok" }) : yield* replyError(400, error);
});

// --- delete ---------------------------------------------------------------------------------------------------------

const unique = (names: ReadonlyArray<string>): string[] => [
  ...new Set(
    names.flatMap((name) => {
      const trimmed = name.trim();

      return trimmed === "" ? [] : [trimmed];
    }),
  ),
];

const strings = (value: Json | undefined): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** `requestedAuthFileNamesForDelete`: `?name=` (repeatable), else a body `{name}`, `{names}` or `[..]`. */
const namesToDelete = (params: URLSearchParams) =>
  Effect.gen(function* () {
    const queried = unique(params.getAll("name"));

    if (queried.length > 0) return queried;
    const body = (yield* bodyText).trim();

    if (body === "") return [];

    const parsed = yield* Effect.try({
      // SAFETY: JSON.parse always returns a JSON value, so naming it Json only records that.
      try: () => JSON.parse(body) as Json,
      catch: () => replyError(400, "invalid request body"),
    });

    if (Array.isArray(parsed)) return unique(strings(parsed));

    if (!isJsonObject(parsed)) return yield* replyError(400, "invalid request body");

    return unique([
      ...(text(parsed.name) === "" ? [] : [text(parsed.name)]),
      ...strings(parsed.names),
    ]);
  });

const deleteCredentials = Effect.gen(function* () {
  const params = yield* queryParams;
  const all = params.get("all");

  if (all === "true" || all === "1" || all === "*") {
    const entries = yield* controlPlane("listCredentialEntries", (stub) =>
      stub.listCredentialEntries(),
    );

    const ids = entries.filter((entry) => entry.source === "file").map((entry) => text(entry.id));
    const removed = yield* controlPlane("removeCredentials", (stub) => stub.removeCredentials(ids));

    return jsonReply(200, { status: "ok", deleted: removed.length });
  }

  const names = yield* namesToDelete(params);

  if (names.length === 0) return yield* replyError(400, "invalid name");
  const unsafe = names.find(unsafeName);

  if (names.length === 1 && unsafe !== undefined) return yield* replyError(400, "invalid name");
  const safe = names.filter((name) => !unsafeName(name));
  const removed = yield* controlPlane("removeCredentials", (stub) => stub.removeCredentials(safe));

  if (names.length === 1) {
    if (removed.length === 1) return jsonReply(200, { status: "ok" });

    yield* refuseConfigKey(names[0] ?? "");

    return yield* replyError(404, "auth file not found");
  }

  const failed = yield* Effect.forEach(
    names.filter((name) => !removed.includes(name)),
    (name) =>
      unsafeName(name)
        ? Effect.succeed({ name, error: "invalid name" })
        : controlPlane("isConfigKey", (stub) => stub.isConfigKey(name)).pipe(
            Effect.map((config) => ({
              name,
              error: config ? "config_credential" : "auth file not found",
            })),
          ),
  );

  if (failed.length > 0)
    return jsonReply(207, { status: "partial", deleted: removed.length, files: removed, failed });

  return jsonReply(200, { status: "ok", deleted: removed.length, files: removed });
});

// --- download / models -------------------------------------------------------------------------------------------

const downloadCredential = Effect.gen(function* () {
  const { principal } = yield* AccessPrincipal;

  if (principal.kind !== "service")
    return yield* replyError(403, "download_requires_service_token", {
      message:
        "downloading a credential file discloses its tokens: call this endpoint with an Access service token (see docs/ACCESS.md)",
    });
  const name = (yield* queryParams).get("name")?.trim() ?? "";

  if (unsafeName(name)) return yield* replyError(400, "invalid name");
  const file = yield* controlPlane("getCredentialFile", (stub) => stub.getCredentialFile(name));

  if (file === undefined) {
    yield* refuseConfigKey(name);

    return yield* replyError(404, "file not found");
  }

  return HttpServerResponse.text(JSON.stringify(file, null, 2), {
    contentType: "application/json",
    headers: { "content-disposition": `attachment; filename="${name.replace(/["\r\n]/g, "_")}"` },
  });
});

const credentialModels = Effect.gen(function* () {
  const name = (yield* queryParams).get("name")?.trim() ?? "";

  if (name === "") return yield* replyError(400, "name is required");
  const registry = yield* ModelRegistry;

  const snapshot = yield* registry.snapshot.pipe(
    Effect.mapError(() => replyError(502, "model registry unavailable")),
  );

  // Auth files by id; config keys only by their `auth_index` (the name the list gives them): a config credential id is
  // derived from its key, so answering for one would confirm guesses.
  const file = snapshot.sources.some((source) => source.source === "file" && source.id === name);

  const configId =
    file || !/^[0-9a-f]{16}$/i.test(name)
      ? undefined
      : yield* controlPlane("credentialIdOfAuthIndex", (stub) =>
          stub.credentialIdOfAuthIndex(name.toLowerCase()),
        );

  const id =
    configId !== undefined &&
    snapshot.sources.some((source) => source.source === "config" && source.id === configId)
      ? configId
      : file
        ? name
        : undefined;

  const models = (id === undefined ? [] : snapshot.modelsForCredential(id)).map((model) => ({
    id: model.id,
    ...(model.displayName === undefined || model.displayName === ""
      ? {}
      : { display_name: model.displayName }),
    ...(model.type === "" ? {} : { type: model.type }),
    ...(model.ownedBy === "" ? {} : { owned_by: model.ownedBy }),
  }));

  return jsonReply(200, { models });
});

// --- status / fields / refresh / cooldown ------------------------------------------------------------------------

const refOf = (body: JsonObject) => {
  const name = text(body.name);
  const authIndex = text(body.auth_index);

  return { ...(name === "" ? {} : { name }), ...(authIndex === "" ? {} : { authIndex }) };
};

const patchStatus = Effect.gen(function* () {
  const body = yield* bodyObject;

  if (text(body.name) === "" && text(body.auth_index) === "")
    return yield* replyError(400, "name is required");

  if (typeof body.disabled !== "boolean") return yield* replyError(400, "disabled is required");

  const result = yield* controlPlane("setCredentialDisabledByRef", (stub) =>
    // SAFETY: typeof body.disabled === "boolean" was checked above; the narrowing is lost inside the callback.
    stub.setCredentialDisabledByRef(refOf(body), body.disabled as boolean),
  );

  // A config API key is disabled through its excluded-models (`*`), like Go answers.
  if (result.ok) {
    return jsonReply(
      200,
      result.via === undefined
        ? { status: "ok", disabled: body.disabled }
        : { status: "ok", disabled: body.disabled, via: result.via, excluded_pattern: "*" },
    );
  }

  if (result.error === "config_credential") {
    return yield* replyError(
      409,
      'config API keys are disabled by adding "*" to their excluded-models in the config',
    );
  }

  if (result.error === "compat_endpoint") {
    return yield* replyError(
      409,
      "OpenAI-compatible keys cannot be disabled one by one: disable the endpoint",
    );
  }

  if (result.error === "invalid") return yield* replyError(422, result.message ?? "invalid config");

  // A listed config account named by its `auth_index` (the toggle goes through the `auth_index` field instead).
  if (text(body.name) !== "") yield* refuseConfigKey(text(body.name));

  return yield* replyError(404, "auth file not found");
});

const patchFields = Effect.gen(function* () {
  const body = yield* bodyObject;
  const name = text(body.name);

  if (name === "") return yield* replyError(400, "name is required");
  const { name: _name, ...fields } = body;

  const result = yield* controlPlane("patchCredentialFields", (stub) =>
    stub.patchCredentialFields({ name }, fields),
  );

  if (result.ok) return jsonReply(200, { status: "ok" });

  if (result.error === "not_found") {
    yield* refuseConfigKey(name);

    return yield* replyError(404, result.message);
  }

  // A refused value names its field (`422`, like the settings writes); a malformed request stays `400`.
  return yield* result.path === undefined
    ? replyError(400, result.message)
    : replyError(422, result.message, { path: result.path });
});

const refreshCredentials = Effect.gen(function* () {
  const params = yield* queryParams;
  const raw = (yield* bodyText).trim();

  const body =
    raw === ""
      ? {}
      : yield* Effect.try({
          // SAFETY: JSON.parse always returns a JSON value, so naming it Json only records that.
          try: () => JSON.parse(raw) as Json,
          catch: () => replyError(400, "invalid request body"),
        });

  if (!isJsonObject(body)) return yield* replyError(400, "invalid request body");
  const all = body.all === true || params.get("all") === "true";

  if (all) {
    const results = yield* controlPlane("refreshAllCredentials", (stub) =>
      stub.refreshAllCredentials(),
    );

    return jsonReply(200, { ok: true, results });
  }

  const name = text(body.name) || (params.get("name")?.trim() ?? "");
  const authIndex = text(body.auth_index) || (params.get("auth_index")?.trim() ?? "");

  if (name === "") return yield* replyError(400, "name or all=true is required");

  const result = yield* controlPlane("refreshCredential", (stub) =>
    stub.refreshCredential({ name, ...(authIndex === "" ? {} : { authIndex }) }),
  );

  if (result.ok) return jsonReply(200, { ok: true, auth: result.entry });

  if (result.error !== "not_found") return yield* replyError(500, result.message);

  yield* refuseConfigKey(name);

  return yield* replyError(404, "auth file not found");
});

const resetCooldown = Effect.gen(function* () {
  const body = yield* bodyJson;

  if (!isJsonObject(body)) return yield* replyError(400, "invalid request body");
  const authIndex = text(body.auth_index);

  if (authIndex === "") return yield* replyError(400, "auth_index is required");

  const result = yield* controlPlane("resetCredentialCooldown", (stub) =>
    stub.resetCredentialCooldown({ authIndex }),
  );

  if (!result.ok) return yield* replyError(404, "auth not found");

  return jsonReply(200, { status: "ok", auth_index: result.authIndex, models: result.models });
});

const BASE = "/v8/management";

export const credentialRoutes = [
  HttpRouter.route("GET", `${BASE}/credentials`, handled(listCredentials)),
  HttpRouter.route("POST", `${BASE}/credentials`, handled(uploadCredentials)),
  HttpRouter.route("DELETE", `${BASE}/credentials`, handled(deleteCredentials)),
  HttpRouter.route("GET", `${BASE}/credentials/download`, handled(downloadCredential)),
  HttpRouter.route("PATCH", `${BASE}/credentials/status`, handled(patchStatus)),
  HttpRouter.route("PATCH", `${BASE}/credentials/fields`, handled(patchFields)),
  HttpRouter.route("POST", `${BASE}/credentials/refresh`, handled(refreshCredentials)),
  HttpRouter.route("POST", `${BASE}/routing/cooldown/reset`, handled(resetCooldown)),
];

/** Needs the `ModelRegistry` service (wired in `routes.ts`). */
export const credentialModelsHandler = handled(credentialModels);
