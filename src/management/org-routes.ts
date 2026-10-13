/**
 * `GET /v8/management/me` and `GET|POST /v8/management/orgs`, `PATCH /v8/management/orgs/:slug` (`OrgsGroup` in
 * contract/orgs.ts): who the caller is, and the org list of the Platform registry (`src/platform`) with its creation and
 * rename. Workers addition, no Go counterpart.
 *
 * The org list, creation and rename are platform-level: they belong to no org, and only a platform admin
 * (`PLATFORM_ADMIN_*`, `AccessIdentity.platformAdmin`) may use them (`403 platform_admin_required`). `GET /me` is for
 * any admin and says which orgs the control panel may open: all of them for a platform admin, `global` for an admin
 * named by its config. Creating an org only adds it to the registry; its ControlPlane starts empty when first used.
 */
import { Clock, Effect, Match } from "effect";
import { HttpRouter } from "effect/http";
import { type AccessIdentity, AccessPrincipal } from "../access/principal.ts";
import type { JsonObject } from "../json/index.ts";
import type { WorkerEnv } from "../platform/env.ts";
import { platform, type PlatformStub } from "../platform/registry.ts";
import type { OrgRecord, OrgWriteResult } from "../platform/registry-store.ts";
import type { OrgView } from "./contract/orgs.ts";
import { bodyObject, handled, jsonReply, replyError, type Reply } from "./http.ts";

const BASE = "/v8/management";

/** Calls the Platform registry; a failed RPC is logged and answered with 502. */
export const registry = <R>(
  label: string,
  call: (stub: PlatformStub) => R,
): Effect.Effect<Awaited<R>, Reply, WorkerEnv> =>
  platform(label, call).pipe(
    Effect.catchTag("PlatformUnavailable", (error) =>
      Effect.logError(`management ${error.message}`).pipe(
        Effect.andThen(Effect.fail(replyError(502, "platform registry unavailable"))),
      ),
    ),
  );

const view = (org: OrgRecord): OrgView => ({
  id: org.id,
  slug: org.slug,
  name: org.name,
  created_at: new Date(org.createdAt).toISOString(),
});

/**
 * The orgs the caller may open in the panel: every org for a platform admin; for anyone else the org their rights are
 * in (`global`), when the registry lists it.
 */
export const manageableOrgs = (
  identity: AccessIdentity,
): Effect.Effect<ReadonlyArray<OrgRecord>, Reply, WorkerEnv> =>
  identity.platformAdmin
    ? registry("listOrgs", (stub) => stub.listOrgs())
    : registry("getOrgById", (stub) => stub.getOrgById(identity.org)).pipe(
        Effect.map((org) => (org === undefined ? [] : [org])),
      );

const requirePlatformAdmin = Effect.gen(function* () {
  const identity = yield* AccessPrincipal;

  if (!identity.platformAdmin)
    return yield* replyError(403, "platform_admin_required", {
      message: "only a platform admin (PLATFORM_ADMIN_*) can manage the list of orgs",
    });
});

const me = Effect.gen(function* () {
  const identity = yield* AccessPrincipal;
  const orgs = yield* manageableOrgs(identity);

  return jsonReply(200, {
    platform_admin: identity.platformAdmin,
    orgs: orgs.map((org) => ({ slug: org.slug, name: org.name })),
  });
});

const list = Effect.gen(function* () {
  yield* requirePlatformAdmin;
  const orgs = yield* registry("listOrgs", (stub) => stub.listOrgs());

  return jsonReply(200, { orgs: orgs.map(view) });
});

interface OrgFields {
  slug?: string;
  name?: string;
}

/** A body with only the allowed string fields; `400 invalid body` for anything else. */
const stringFields = (
  body: JsonObject,
  allowed: ReadonlyArray<keyof OrgFields>,
): Effect.Effect<OrgFields, Reply> => {
  const fields: OrgFields = {};

  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) continue;

    const known = key === "slug" || key === "name";

    if (!known || !allowed.includes(key) || typeof value !== "string") {
      return Effect.fail(replyError(400, "invalid body"));
    }

    fields[key] = value;
  }

  return Effect.succeed(fields);
};

/** The refusal of a registry write, as the response the contract names. */
const refused = (result: Extract<OrgWriteResult, { ok: false }>): Reply =>
  Match.value(result.error).pipe(
    Match.when("slug_taken", () => replyError(409, "slug_taken", { message: result.message })),
    Match.when("not_found", () => replyError(404, "org_not_found", { message: result.message })),
    Match.orElse((error) => replyError(422, error, { message: result.message })),
  );

const create = Effect.gen(function* () {
  yield* requirePlatformAdmin;
  const body = yield* bodyObject;
  const { slug, name } = yield* stringFields(body, ["slug", "name"]);

  if (slug === undefined || name === undefined) return yield* replyError(400, "invalid body");
  const now = yield* Clock.currentTimeMillis;
  const result = yield* registry("createOrg", (stub) => stub.createOrg({ slug, name }, now));

  if (!result.ok) return yield* refused(result);

  return jsonReply(201, view(result.org));
});

const update = Effect.gen(function* () {
  yield* requirePlatformAdmin;
  const { slug: current } = yield* HttpRouter.params;
  const body = yield* bodyObject;
  const patch = yield* stringFields(body, ["slug", "name"]);

  if (current === undefined || (patch.slug === undefined && patch.name === undefined))
    return yield* replyError(400, "invalid body");
  const result = yield* registry("updateOrg", (stub) => stub.updateOrg(current, patch));

  if (!result.ok) return yield* refused(result);

  return jsonReply(200, view(result.org));
});

export const orgRoutes = [
  HttpRouter.route("GET", `${BASE}/me`, handled(me)),
  HttpRouter.route("GET", `${BASE}/orgs`, handled(list)),
  HttpRouter.route("POST", `${BASE}/orgs`, handled(create)),
  HttpRouter.route("PATCH", `${BASE}/orgs/:slug`, handled(update)),
];
