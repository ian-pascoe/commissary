/**
 * `GET /v8/management/me` and `GET|POST /v8/management/orgs`, `PATCH /v8/management/orgs/:slug` (`OrgsGroup` in
 * contract/orgs.ts): who the caller is, and the org list of the Platform registry (`src/platform`) with its creation and
 * rename. Workers addition, no Go counterpart.
 *
 * The org list, creation and rename are platform-level: they belong to no org, and only a platform admin
 * (`PLATFORM_ADMIN_*`, `AccessIdentity.platformAdmin`) may use them (`403 platform_admin_required`). `GET /me` is for
 * anyone Access admits and says which orgs the control panel may open (all of them for a platform admin, the orgs the
 * caller is a member of otherwise) and the caller's role in the addressed org. Creating an org only adds it to the
 * registry; its ControlPlane starts empty when first used.
 */
import { Clock, Effect, Match } from "effect";
import { HttpRouter } from "effect/http";
import { type AccessIdentity, AccessPrincipal } from "../access/principal.ts";
import type { JsonObject } from "../json/index.ts";
import { WorkerEnv } from "../platform/env.ts";
import { controlPlaneOf, newOrgId } from "../platform/org.ts";
import { platform, type PlatformStub } from "../platform/registry.ts";
import type { OrgRecord, OrgWriteResult } from "../platform/registry-store.ts";
import type { OrgView } from "./contract/orgs.ts";
import { bodyObject, controlPlane, handled, jsonReply, replyError, type Reply } from "./http.ts";

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
 * The orgs the caller may open in the panel: every org for a platform admin; for anyone else the orgs the Platform
 * registry indexes them in (ADR 0022), and the org of the request when the gate admitted them there.
 */
export const openableOrgs = (
  identity: AccessIdentity,
): Effect.Effect<ReadonlyArray<OrgRecord>, Reply, WorkerEnv> =>
  Effect.gen(function* () {
    if (identity.platformAdmin) return yield* registry("listOrgs", (stub) => stub.listOrgs());
    const { principal } = identity;

    const indexed =
      principal.kind === "service"
        ? yield* registry("orgOfServiceToken", (stub) =>
            stub.orgOfServiceToken(principal.commonName),
          ).pipe(Effect.map((org) => (org === undefined ? [] : [org])))
        : yield* registry("orgsOfEmail", (stub) => stub.orgsOfEmail(principal.email));

    if (identity.role === undefined || indexed.some((org) => org.id === identity.org))
      return indexed;
    const current = yield* registry("getOrgById", (stub) => stub.getOrgById(identity.org));

    return current === undefined ? indexed : [...indexed, current];
  });

const requirePlatformAdmin = Effect.gen(function* () {
  const identity = yield* AccessPrincipal;

  if (!identity.platformAdmin)
    return yield* replyError(403, "platform_admin_required", {
      message: "only a platform admin (PLATFORM_ADMIN_*) can manage the list of orgs",
    });
});

const me = Effect.gen(function* () {
  const identity = yield* AccessPrincipal;
  const orgs = yield* openableOrgs(identity);

  const settings =
    identity.role === undefined
      ? undefined
      : yield* controlPlane("membershipSettings", (stub) => stub.membershipSettings());

  return jsonReply(200, {
    platform_admin: identity.platformAdmin,
    role: identity.role ?? null,
    orgs: orgs.map((org) => ({ slug: org.slug, name: org.name })),
    ...(settings === undefined ? {} : { private_credentials: settings.privateCredentials }),
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
  const { private_credentials: privateCredentials, ...named } = body;

  if (privateCredentials !== undefined && typeof privateCredentials !== "boolean")
    return yield* replyError(400, "invalid body");
  const { slug, name } = yield* stringFields(named, ["slug", "name"]);

  if (slug === undefined || name === undefined) return yield* replyError(400, "invalid body");
  const now = yield* Clock.currentTimeMillis;
  const id = newOrgId();

  // The creator chooses whether members of the new org may connect private credentials (off unless asked). The org's
  // ControlPlane takes the choice before the org exists in the registry: a failure here creates nothing (a retry is safe),
  // and an org that does exist never has a different setting than the one chosen. A refused registry write leaves the
  // unreachable ControlPlane of an id nobody holds, which has no slug and is never addressed.
  if (privateCredentials === true) {
    const env = yield* WorkerEnv;

    yield* Effect.tryPromise({
      try: async () =>
        await controlPlaneOf(env, id).setMembershipSettings({ privateCredentials: true }),
      catch: () => replyError(502, "control plane unavailable"),
    });
  }

  const result = yield* registry("createOrg", (stub) => stub.createOrg({ slug, name, id }, now));

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
