/**
 * `GET|PATCH /v8/management/settings` (`SettingsGroup` in contract/settings.ts): the control panel's Settings page.
 *
 * Workers addition, no Go counterpart (Go's panel edits `/config` paths without a version). Reads go straight to the
 * ControlPlane, so a write shows on the next read. A write carries the `version` of the view it was made from and is
 * stored with `putConfig(text, version)` and no retry: a stale view is `409 conflict`. The patch is checked
 * (`settings.ts`: owned paths, value rules, survival through the config decoder, who may change the admin service
 * tokens, admin lock-out) before anything is
 * stored; refusals carry `{error, message, path}`.
 */
import { Effect, Result, Schema } from "effect";
import { HttpRouter } from "effect/http";
import { platformAdminLists } from "../access/config.ts";
import { AccessPrincipal } from "../access/principal.ts";
import { decodeConfig } from "../config/codec.ts";
import { decodeStoredConfig } from "../config/store.ts";
import { isJsonObject, type JsonObject } from "../json/index.ts";
import { WorkerEnv } from "../platform/env.ts";
import { ConfigVersion } from "./contract/config.ts";
import { bodyJson, controlPlane, handled, jsonReply, replyError } from "./http.ts";
import {
  applySettingsPatch,
  checkAdminLockout,
  checkServiceTokenAdmins,
  checkSurvival,
  type SettingsProblem,
  settingsView,
  validateSettings,
} from "./settings.ts";

const PATH = "/v8/management/settings";

const refuse = (refused: SettingsProblem) =>
  replyError(refused.status, refused.error, { message: refused.message, path: refused.path });

const orRefuse = <A>(result: Result.Result<A, SettingsProblem>) =>
  Result.isSuccess(result) ? Effect.succeed(result.success) : Effect.fail(refuse(result.failure));

const failIf = (refused: SettingsProblem | undefined) =>
  refused === undefined ? Effect.void : Effect.fail(refuse(refused));

/** The stored config at its version, decoded; a failed decode of the stored document is an internal error. */
export const storedConfig = Effect.gen(function* () {
  const wire = yield* controlPlane("getConfig", (stub) => stub.getConfig());
  const text = wire.document ?? "{}";

  const config = yield* decodeStoredConfig(text).pipe(
    Effect.mapError(() => replyError(500, "invalid_config")),
  );

  // SAFETY: the stored config document is always a serialized JSON object (writes reject non-objects).
  return {
    version: wire.version,
    updatedAt: wire.updatedAt,
    document: JSON.parse(text) as JsonObject,
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
      updatedAt: current.updatedAt,
      envAdmins: platformAdminLists(env),
      prefixedCredentials: sources.filter((source) => (source.prefix ?? "").trim() !== "").length,
    }),
  );
});

const SaveBody = Schema.Struct({ version: ConfigVersion });

const invalidBody = () => replyError(400, "invalid body");

/** Whether the caller stays an admin whatever the config says: a platform admin (`PLATFORM_ADMIN_*`, or the local dev bypass). */
export const alwaysAdmin = Effect.gen(function* () {
  const identity = yield* AccessPrincipal;

  return identity.platformAdmin;
});

const save = Effect.gen(function* () {
  const raw = yield* bodyJson;

  if (!isJsonObject(raw) || !isJsonObject(raw.patch)) return yield* invalidBody();

  const { version } = yield* Schema.decodeUnknownEffect(SaveBody)(raw).pipe(
    Effect.mapError(invalidBody),
  );

  const edits = yield* orRefuse(validateSettings(raw.patch));
  const current = yield* storedConfig;

  if (current.version !== version)
    return yield* replyError(409, "conflict", {
      message: `config changed since version ${version} (now ${current.version})`,
    });
  const edited = yield* orRefuse(applySettingsPatch(current.document, edits));

  // Dry run through the decoder (what the ControlPlane will store): every written value must be kept as sent.
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

  const result = yield* controlPlane("putConfig", (stub) =>
    stub.putConfig(JSON.stringify(edited), version),
  );

  if (result.ok) {
    if (result.notApplied.length > 0) {
      yield* Effect.logWarning("config keys not applied on Workers (see MIGRATION.md)").pipe(
        Effect.annotateLogs({ keys: result.notApplied.join(", ") }),
      );
    }

    return jsonReply(200, { status: "ok", version: result.version });
  }

  if (result.error === "conflict")
    return yield* replyError(409, "conflict", { message: result.message });

  return yield* replyError(422, "invalid_setting", { message: result.message });
});

export const settingsRoutes = [
  HttpRouter.route("GET", PATH, handled(view)),
  HttpRouter.route("PATCH", PATH, handled(save)),
];
