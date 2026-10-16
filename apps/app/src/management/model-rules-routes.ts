/**
 * `PUT|DELETE /v9/management/model-rules/aliases/:channel` and `/model-rules/exclusions/:channel` (`RoutingGroup` in
 * @commissary/contract/routing): the Models page's channel rule edits. Workers addition, no Go counterpart (Go's panel
 * writes `oauth.model-alias` and `oauth.excluded-models` through `/config` paths).
 *
 * Each channel's aliases and exclusions are a config entry (ADR 0025). An edit replaces the channel's whole list (`PUT`)
 * or removes it (`DELETE`, `404 not_found` when the channel has none), and names the revision it was based on in
 * `If-Match` (`"12"`, `W/"12"` or `12`; 0 for a channel without rules): a channel changed since answers
 * `409 conflict` and nothing is stored; a missing or malformed header is `400 invalid_if_match`. The channel is the
 * config's key, trimmed and lower-cased like the normaliser does. A list is stored as the normaliser keeps it; one of
 * which nothing would be kept is `422 invalid_config`.
 */
import { Effect } from "effect";
import { HttpRouter } from "effect/http";
import { AccessPrincipal } from "../access/principal.ts";
import { decodeConfig } from "../config/codec.ts";
import type { ChannelRuleKind, WriteResult } from "../config/store.ts";
import { isJsonArray, type Json } from "@commissary/json";
import { handled, ifMatch, jsonReply, replyError } from "@commissary/core";
import { bodyJson } from "./http.ts";
import { modelsControlPlane } from "../models/env.ts";

const BASE = "/v9/management/model-rules";

/** The config key of each kind's channel map. */
const CONFIG_KEYS: Readonly<Record<ChannelRuleKind, "model-alias" | "excluded-models">> = {
  aliases: "model-alias",
  exclusions: "excluded-models",
};

/** The `:channel` parameter as the config keys it (trimmed, lower-case); empty is `400 invalid_channel`. */
const channelParam = Effect.gen(function* () {
  const { channel } = yield* HttpRouter.params;
  let decoded = "";

  try {
    decoded = decodeURIComponent(channel ?? "");
  } catch {
    return yield* replyError(400, "invalid_channel");
  }

  const key = decoded.trim().toLowerCase();

  return key === "" ? yield* replyError(400, "invalid_channel") : key;
});

/** `list` as the config normaliser keeps it under `channel` (`undefined`: nothing would be kept). */
const normalised = (kind: ChannelRuleKind, channel: string, list: Json) =>
  decodeConfig({ oauth: { [CONFIG_KEYS[kind]]: { [channel]: list } } }).pipe(
    Effect.mapError((error) =>
      replyError(422, "invalid_config", {
        message: error.message,
        ...(error.path === undefined ? {} : { path: error.path }),
      }),
    ),
    Effect.map((config): Json | undefined => {
      const kept: unknown = config.oauth[CONFIG_KEYS[kind]][channel];

      // SAFETY: the config schema's channel lists are plain JSON values (aliases or pattern strings).
      return Array.isArray(kept) && kept.length > 0 ? (structuredClone(kept) as Json) : undefined;
    }),
  );

const written = (result: WriteResult<{ readonly revision: number }>) => {
  if (result.ok)
    return Effect.succeed(
      jsonReply(200, { status: "ok", version: result.version, revision: result.revision }),
    );

  if (result.error === "conflict")
    return Effect.fail(replyError(409, "conflict", { message: result.message }));

  if (result.error === "not_found") return Effect.fail(replyError(404, "not_found"));

  return Effect.fail(replyError(422, "invalid_config", { message: result.message }));
};

const put = (kind: ChannelRuleKind) =>
  Effect.gen(function* () {
    const channel = yield* channelParam;
    const revision = yield* ifMatch;
    const body = yield* bodyJson;

    if (!isJsonArray(body)) return yield* replyError(400, "invalid body");
    const value = yield* normalised(kind, channel, body);

    if (value === undefined)
      return yield* replyError(422, "invalid_config", {
        message: "no rule of this list would be kept",
      });
    const { principalId } = yield* AccessPrincipal;

    const result = yield* modelsControlPlane("writeChannelRule", (stub) =>
      stub.writeChannelRule(kind, channel, revision, value, principalId),
    );

    return yield* written(result);
  });

const remove = (kind: ChannelRuleKind) =>
  Effect.gen(function* () {
    const channel = yield* channelParam;
    const revision = yield* ifMatch;
    const { principalId } = yield* AccessPrincipal;

    const result = yield* modelsControlPlane("writeChannelRule", (stub) =>
      stub.writeChannelRule(kind, channel, revision, null, principalId),
    );

    return yield* written(result);
  });

export const modelRuleRoutes = (["aliases", "exclusions"] as const).flatMap((kind) => [
  HttpRouter.route("PUT", `${BASE}/${kind}/:channel`, handled(put(kind))),
  HttpRouter.route("DELETE", `${BASE}/${kind}/:channel`, handled(remove(kind))),
]);
