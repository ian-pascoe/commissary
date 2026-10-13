/**
 * `/v8/management/proxy-keys` (`ProxyKeysGroup` in contract/proxy-keys.ts): the proxy keys clients send instead of an
 * Access sign-in (ADR 0022). Workers addition, no Go counterpart.
 *
 * Any member of the org may use these routes (`access/policy.ts`): a member creates keys for themselves and lists and
 * revokes their own; an org admin (or a platform admin) lists and revokes every key of the org. Keys are issued to
 * members only, so a caller without a member id in the org (a service token, a platform admin from outside) cannot
 * create one. A revoked key is forgotten by this isolate's cache at once (`access/proxy-key.ts`).
 */
import { Clock, Effect, Schema } from "effect";
import { HttpRouter, type HttpServerResponse } from "effect/http";
import { type AccessIdentity, AccessPrincipal } from "../access/principal.ts";
import { forgetVerifiedProxyKey } from "../access/proxy-key.ts";
import { roleAtLeast } from "../members/roles.ts";
import type { ProxyKeyErrorCode, ProxyKeyListing, ProxyKeyResult } from "../proxy-keys/store.ts";
import { CreateProxyKey, type ProxyKeyView } from "./contract/proxy-keys.ts";
import { bodyJson, controlPlane, handled, jsonReply, type Reply, replyError } from "./http.ts";

const BASE = "/v8/management";

const STATUS: Readonly<Record<ProxyKeyErrorCode | "member_not_found", number>> = {
  invalid_name: 422,
  invalid_expiry: 422,
  too_many_keys: 409,
  proxy_key_not_found: 404,
  member_not_found: 403,
};

const iso = (ms: number): string => new Date(ms).toISOString();

const view = (key: ProxyKeyListing, caller: AccessIdentity): ProxyKeyView => ({
  id: key.id,
  name: key.name,
  prefix: key.prefix,
  member_id: key.memberId,
  ...(key.memberEmail === undefined ? {} : { member_email: key.memberEmail }),
  mine: key.memberId === caller.memberId,
  created_at: iso(key.createdAt),
  ...(key.lastUsedAt === undefined ? {} : { last_used_at: iso(key.lastUsedAt) }),
  ...(key.expiresAt === undefined ? {} : { expires_at: iso(key.expiresAt) }),
  ...(key.revokedAt === undefined ? {} : { revoked_at: iso(key.revokedAt) }),
});

const orRefuse = <A>(
  result:
    | ProxyKeyResult<A>
    | { readonly ok: false; readonly error: "member_not_found"; readonly message: string },
): Effect.Effect<A, Reply> =>
  result.ok
    ? Effect.succeed(result.value)
    : Effect.fail(replyError(STATUS[result.error], result.error, { message: result.message }));

/** Org admins (and platform admins, owners of every org) see and revoke every key of the org. */
const managesEveryKey = (identity: AccessIdentity): boolean =>
  identity.platformAdmin || roleAtLeast(identity.role, "admin");

const memberRequired = () =>
  replyError(403, "member_required", {
    message: "proxy keys are issued to members of the org; add yourself as a member first",
  });

const listProxyKeys = Effect.gen(function* () {
  const identity = yield* AccessPrincipal;
  const every = managesEveryKey(identity);

  if (!every && identity.memberId === undefined) return jsonReply(200, { keys: [] });

  const keys = yield* controlPlane("listProxyKeys", (stub) =>
    stub.listProxyKeys(every ? undefined : identity.memberId),
  );

  return jsonReply(200, { keys: keys.map((key) => view(key, identity)) });
});

const createProxyKey = Effect.gen(function* () {
  const identity = yield* AccessPrincipal;
  const memberId = identity.memberId;

  if (memberId === undefined) return yield* memberRequired();

  const input = yield* bodyJson.pipe(
    Effect.flatMap((json) =>
      Schema.decodeUnknownEffect(CreateProxyKey)(json).pipe(
        Effect.mapError(() => replyError(400, "invalid body")),
      ),
    ),
  );

  const expiresAt = input.expires_at === undefined ? undefined : Date.parse(input.expires_at);

  if (expiresAt !== undefined && Number.isNaN(expiresAt))
    return yield* replyError(422, "invalid_expiry", { message: "expires_at is an ISO 8601 time" });
  const now = yield* Clock.currentTimeMillis;

  const result = yield* controlPlane("createProxyKey", (stub) =>
    stub.createProxyKey(
      { memberId, name: input.name, ...(expiresAt === undefined ? {} : { expiresAt }) },
      now,
    ),
  );

  const created = yield* orRefuse(result);

  return jsonReply(201, { ...view(created.record, identity), key: created.key });
});

const revokeProxyKey = Effect.gen(function* () {
  const identity = yield* AccessPrincipal;
  const params = yield* HttpRouter.params;
  const id = params["id"] ?? "";
  const every = managesEveryKey(identity);

  if (!every && identity.memberId === undefined)
    return yield* replyError(404, "proxy_key_not_found", { message: "no proxy key has this id" });
  const now = yield* Clock.currentTimeMillis;

  const result = yield* controlPlane("revokeProxyKey", (stub) =>
    stub.revokeProxyKey(id, now, every ? undefined : identity.memberId),
  );

  const revoked = yield* orRefuse(result);
  forgetVerifiedProxyKey(identity.org, revoked.id);

  return jsonReply(200, view(revoked, identity));
});

const route = <R>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, Reply, R>,
) => HttpRouter.route(method, `${BASE}${path}`, handled(handler));

export const proxyKeyRoutes = [
  route("GET", "/proxy-keys", listProxyKeys),
  route("POST", "/proxy-keys", createProxyKey),
  route("DELETE", "/proxy-keys/:id", revokeProxyKey),
];
