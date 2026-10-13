/**
 * `GET|PATCH /v8/management/settings` and `POST /v8/management/settings/import` (`SettingsGroup` in
 * contract/settings.ts): the control panel's Settings page and the Go config import.
 *
 * Workers addition, no Go counterpart (Go's panel edits `/config` paths without a version). Every setting is a config
 * entry of its own (ADR 0025, `config/entries.ts`): the view carries the revision of every stored setting, and a
 * write names the revision of each setting it changes (absent = 0, not stored). The ControlPlane refuses the write
 * with `409 conflict` when one of them changed since; writes to other settings never conflict. The patch is checked
 * (`settings.ts`: owned paths, value rules, survival through the config decoder, who may change the admin service
 * tokens, admin lock-out) before anything is stored; refusals carry `{error, message, path}`.
 *
 * The import replaces every config entry of the org with a Go config document (YAML or JSON, v8 or legacy layout) in
 * one transaction, and answers the keys that have no effect on Workers, which it does not store (ADR 0015). It is the
 * one write of the whole configuration, and the same admin rules apply: only a service-token administrator or a
 * platform admin may change the admin service tokens, and a caller may not remove their own admin access. Those
 * checks read the stored config; the import names its change counter and is `409 conflict` when another write landed
 * in between, so they never pass on a stale read. A key whose secret is already stored keeps that key's credential id.
 */
import { Effect, Result, Schema } from "effect";
import { HttpRouter } from "effect/http";
import { platformAdminLists } from "../access/config.ts";
import { AccessPrincipal } from "../access/principal.ts";
import { decodeConfig, parseConfigYaml } from "../config/codec.ts";
import { decodeStoredConfig } from "../config/store.ts";
import { isJsonObject, type JsonObject } from "../json/index.ts";
import { WorkerEnv } from "../platform/env.ts";
import { Revisions } from "./contract/config.ts";
import { boundedBodyText, bodyJson, controlPlane, handled, jsonReply, replyError } from "./http.ts";
import {
  applySettingsPatch,
  checkAdminLockout,
  checkDocumentLockout,
  checkServiceTokenAdmins,
  checkSurvival,
  type SettingsProblem,
  settingsView,
  validateSettings,
} from "./settings.ts";

const PATH = "/v8/management/settings";

/** The largest config document the import takes. */
const MAX_IMPORT_BYTES = 512 * 1024;

const refuse = (refused: SettingsProblem) =>
  replyError(refused.status, refused.error, { message: refused.message, path: refused.path });

const orRefuse = <A>(result: Result.Result<A, SettingsProblem>) =>
  Result.isSuccess(result) ? Effect.succeed(result.success) : Effect.fail(refuse(result.failure));

const failIf = (refused: SettingsProblem | undefined) =>
  refused === undefined ? Effect.void : Effect.fail(refuse(refused));

/**
 * The org's config as its entries make it up, with the revision of every entry; a failed decode of the assembled
 * document is an internal error.
 */
export const storedConfig = Effect.gen(function* () {
  const wire = yield* controlPlane("configEntries", (stub) => stub.configEntries());

  const config = yield* decodeStoredConfig(wire.document).pipe(
    Effect.mapError(() => replyError(500, "invalid_config")),
  );

  // SAFETY: the assembled config document is always a serialized JSON object (`ConfigStore.current`).
  const document = JSON.parse(wire.document) as JsonObject;

  return {
    version: wire.version,
    updatedAt: wire.updatedAt,
    revisions: wire.revisions,
    document,
    config,
  };
});

const view = Effect.gen(function* () {
  const env = yield* WorkerEnv;
  const current = yield* storedConfig;
  const sources = yield* controlPlane("listModelSources", (stub) => stub.listModelSources());

  return jsonReply(
    200,
    settingsView({
      config: current.config,
      version: current.version,
      revisions: current.revisions.settings,
      updatedAt: current.updatedAt,
      envAdmins: platformAdminLists(env),
      prefixedCredentials: sources.filter((source) => (source.prefix ?? "").trim() !== "").length,
    }),
  );
});

const SaveBody = Schema.Struct({ revisions: Revisions });

const invalidBody = () => replyError(400, "invalid body");

/** Whether the caller stays an admin whatever the config says: a platform admin (`PLATFORM_ADMIN_*`, or the local dev bypass). */
export const alwaysAdmin = Effect.gen(function* () {
  const identity = yield* AccessPrincipal;

  return identity.platformAdmin;
});

const save = Effect.gen(function* () {
  const raw = yield* bodyJson;

  if (!isJsonObject(raw) || !isJsonObject(raw.patch)) return yield* invalidBody();

  const { revisions } = yield* Schema.decodeUnknownEffect(SaveBody)(raw).pipe(
    Effect.mapError(invalidBody),
  );

  const edits = yield* orRefuse(validateSettings(raw.patch));
  const current = yield* storedConfig;
  const edited = yield* orRefuse(applySettingsPatch(current.document, edits));

  // Dry run through the decoder (what the ControlPlane will assemble): every written value must be kept as sent.
  const normalised = yield* decodeConfig(edited).pipe(
    Effect.mapError((error) => replyError(422, "invalid_setting", { message: error.message })),
  );

  yield* failIf(checkSurvival(edits, normalised));
  const identity = yield* AccessPrincipal;

  yield* failIf(
    checkServiceTokenAdmins({
      before: current.config,
      after: normalised,
      principal: identity.principal,
      alwaysAdmin: yield* alwaysAdmin,
    }),
  );

  yield* failIf(
    checkAdminLockout({
      edits,
      after: normalised,
      principal: identity.principal,
      alwaysAdmin: yield* alwaysAdmin,
    }),
  );

  const changes = edits.map((edit) => {
    const id = edit.path.join(".");

    return {
      id,
      revision: Object.hasOwn(revisions, id) ? (revisions[id] ?? 0) : 0,
      value: edit.value,
    };
  });

  const result = yield* controlPlane("writeSettings", (stub) =>
    stub.writeSettings(changes, identity.principalId),
  );

  if (result.ok)
    return jsonReply(200, { status: "ok", version: result.version, revisions: result.revisions });

  if (result.error === "conflict")
    return yield* replyError(409, "conflict", { message: result.message });

  return yield* replyError(422, "invalid_setting", { message: result.message });
});

/** `POST /settings/import`: replaces every config entry with a Go config document. */
const importDocument = Effect.gen(function* () {
  const text = yield* boundedBodyText(MAX_IMPORT_BYTES);
  const parsed = yield* Effect.result(parseConfigYaml(text));

  if (Result.isFailure(parsed)) {
    const error = parsed.failure;

    return yield* replyError(422, "invalid_config", {
      message: error.message,
      ...(error.path === undefined ? {} : { path: error.path }),
      ...(error.line === undefined ? {} : { line: error.line }),
      ...(error.column === undefined ? {} : { column: error.column }),
    });
  }

  const current = yield* storedConfig;
  const identity = yield* AccessPrincipal;
  const always = yield* alwaysAdmin;
  const rules = { before: current.config, after: parsed.success, principal: identity.principal };

  yield* failIf(checkServiceTokenAdmins({ ...rules, alwaysAdmin: always }));
  yield* failIf(checkDocumentLockout({ ...rules, alwaysAdmin: always }));

  const result = yield* controlPlane("importConfig", (stub) =>
    stub.importConfig(text, identity.principalId, current.version),
  );

  if (!result.ok && result.error === "conflict")
    return yield* replyError(409, "conflict", { message: result.message });

  if (!result.ok)
    return yield* replyError(422, "invalid_config", {
      message: result.message,
      ...(result.path === undefined ? {} : { path: result.path }),
      ...(result.line === undefined ? {} : { line: result.line }),
      ...(result.column === undefined ? {} : { column: result.column }),
    });

  if (result.notApplied.length > 0)
    yield* Effect.logWarning("config import: keys not applied on Workers (see MIGRATION.md)").pipe(
      Effect.annotateLogs({ keys: result.notApplied.join(", ") }),
    );

  return jsonReply(200, {
    status: "ok",
    version: result.version,
    not_applied: [...result.notApplied],
  });
});

export const settingsRoutes = [
  HttpRouter.route("GET", PATH, handled(view)),
  HttpRouter.route("PATCH", PATH, handled(save)),
  HttpRouter.route("POST", `${PATH}/import`, handled(importDocument)),
];
