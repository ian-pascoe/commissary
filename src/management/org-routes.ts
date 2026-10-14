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
import { Clock, Data, Effect, Match } from "effect";
import { HttpRouter } from "effect/http";
import { type AccessIdentity, AccessPrincipal } from "../access/principal.ts";
import { forgetOrgProxyKeys } from "../access/proxy-key.ts";
import { syncOrgIndex } from "../members/admission.ts";
import { roleAtLeast } from "../members/roles.ts";
import type { JsonObject } from "../json/index.ts";
import { WorkerEnv } from "../platform/env.ts";
import { controlPlaneOf, GLOBAL_ORG, newOrgId } from "../platform/org.ts";
import { deleteOrg as deleteOrgData } from "../platform/org-deletion.ts";
import { platform, type PlatformStub } from "../platform/registry.ts";
import type { OrgRecord, OrgWriteResult } from "../platform/registry-store.ts";
import type { OrgView } from "./contract/orgs.ts";
import type { GrantSubject } from "../grants/grant.ts";
import { maskConfigSecrets } from "./export-view.ts";
import { bodyObject, controlPlane, handled, jsonReply, replyError, type Reply } from "./http.ts";
import { storedConfig } from "./settings-routes.ts";
import { currentViewer } from "./viewer.ts";

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
  usage_retention_days: org.usageRetentionDays,
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

/** The org the request addresses, from the registry (`404 org_not_found` when it is no longer listed). */
const addressedOrg = Effect.gen(function* () {
  const identity = yield* AccessPrincipal;
  const org = yield* registry("getOrgById", (stub) => stub.getOrgById(identity.org));

  return org ?? (yield* replyError(404, "org_not_found", { message: "no org has this id" }));
});

const own = addressedOrg.pipe(Effect.map((org) => jsonReply(200, view(org))));

const updateSettings = Effect.gen(function* () {
  const identity = yield* AccessPrincipal;
  const body = yield* bodyObject;
  const days = body["usage_retention_days"];

  if (
    Object.keys(body).some((key) => key !== "usage_retention_days") ||
    (days !== null && typeof days !== "number")
  )
    return yield* replyError(400, "invalid body");

  const result = yield* registry("setUsageRetention", (stub) =>
    stub.setUsageRetention(identity.org, days),
  );

  if (!result.ok) return yield* refused(result);

  return jsonReply(200, view(result.org));
});

/** A grant's subject by what a person reads: the member's email or the team's name instead of an id. */
const exportedSubject = (
  subject: GrantSubject,
  members: ReadonlyMap<string, string>,
  teams: ReadonlyMap<string, string>,
): JsonObject => {
  if (subject.kind === "member") return { kind: "member", email: members.get(subject.id) ?? "" };

  if (subject.kind === "team") return { kind: "team", name: teams.get(subject.id) ?? "" };

  return { kind: "everyone" };
};

const exportOrg = Effect.gen(function* () {
  const org = yield* addressedOrg;
  const viewer = yield* currentViewer;
  const now = yield* Clock.currentTimeMillis;
  const config = yield* storedConfig;
  const prices = yield* controlPlane("priceOverrideEntries", (stub) => stub.priceOverrideEntries());

  const credentials = yield* controlPlane("listCredentialEntries", (stub) =>
    stub.listCredentialEntries(viewer),
  );

  const members = yield* controlPlane("listMembers", (stub) => stub.listMembers());
  const grants = yield* controlPlane("grantEntries", (stub) => stub.grantEntries());
  const teams = yield* controlPlane("listTeams", (stub) => stub.listTeams());
  const tokens = yield* controlPlane("listServiceTokens", (stub) => stub.listServiceTokens());
  const iso = (at: number) => new Date(at).toISOString();
  const byId = new Map(members.map((member) => [member.id, member.email]));
  const teamNames = new Map(teams.map((team) => [team.id, team.name]));

  return jsonReply(200, {
    exported_at: iso(now),
    org: view(org),
    config: maskConfigSecrets(config.document),
    prices: prices.overrides.map(({ id: _id, revision: _revision, ...price }) => ({
      ...price,
      updated_at: iso(price.updated_at),
    })),
    credentials,
    grants: grants.grants.map((grant) => ({
      subject: exportedSubject(grant.subject, byId, teamNames),
      scope: grant.scope,
      models: grant.models,
      updated_at: iso(grant.updated_at),
    })),
    members: members.map((member) => ({
      email: member.email,
      role: member.role,
      added_at: iso(member.addedAt),
      teams: member.teams.flatMap((id) => teams.find((team) => team.id === id)?.name ?? []),
    })),
    teams: teams.map((team) => ({
      name: team.name,
      created_at: iso(team.createdAt),
      members: team.members.flatMap((id) => byId.get(id) ?? []),
    })),
    service_tokens: tokens.map((token) => ({
      client_id: token.clientId,
      name: token.name,
      role: token.role,
      added_at: iso(token.addedAt),
    })),
  });
});

/** A deletion that threw: the cause is logged (never with payloads) and the caller is told to try again. */
class DeletionThrew extends Data.TaggedError("DeletionThrew")<{ readonly cause: unknown }> {}

const deletionFailed = (org: string) => (error: DeletionThrew) =>
  Effect.logError("org deletion failed").pipe(
    Effect.annotateLogs({
      org,
      cause: error.cause instanceof Error ? error.cause.message : "unknown error",
    }),
    Effect.andThen(Effect.fail(replyError(502, "org deletion failed"))),
  );

const deleteOrgRoute = Effect.gen(function* () {
  const identity = yield* AccessPrincipal;

  if (!roleAtLeast(identity.role, "owner"))
    return yield* replyError(403, "owner_required", {
      message: "only an org owner or a platform admin can delete the org",
    });

  const body = yield* bodyObject;
  const org = yield* addressedOrg;

  if (Object.keys(body).some((key) => key !== "name") || typeof body["name"] !== "string")
    return yield* replyError(400, "invalid body");

  if (org.id === GLOBAL_ORG)
    return yield* replyError(409, "global_org", {
      message: "the first org holds the deployment's own settings and is never deleted",
    });

  if (body["name"] !== org.name)
    return yield* replyError(422, "name_mismatch", {
      message: "type the org's name exactly to confirm that it is deleted with everything in it",
    });

  const env = yield* WorkerEnv;
  const now = yield* Clock.currentTimeMillis;

  const outcome = yield* Effect.tryPromise({
    try: async () => await deleteOrgData(env, org.id, { now }),
    catch: (cause) => new DeletionThrew({ cause }),
  }).pipe(Effect.catch(deletionFailed(org.id)));

  forgetOrgProxyKeys(org.id);

  if (outcome.state === "incomplete") {
    yield* Effect.logWarning("org deletion incomplete").pipe(
      Effect.annotateLogs({ org: org.id, step: outcome.step }),
    );

    return yield* replyError(503, "deletion_incomplete", {
      message: "the org still holds data; send the request again",
    });
  }

  if (outcome.state === "refused")
    return yield* replyError(409, outcome.reason === "global" ? "global_org" : "org_not_found", {
      message: outcome.message,
    });

  return jsonReply(200, { deleted: true, id: org.id, slug: org.slug });
});

/**
 * `DELETE /me`: a person deletes their own account (ADR 0027). They leave every org they belong to with everything of
 * theirs; an org they are the only member of is deleted with all it holds; an org they are the only owner of while
 * others belong is not left ownerless: `409 sole_owner` names such orgs and nothing changes. The first org holds the
 * deployment's own settings and is never deleted: a person alone in it only leaves it.
 *
 * Seam for hosted sign-in (#72): the account of a hosted sign-in (its password, sessions and identity) is kept outside
 * the orgs, and its deletion belongs here after the last org step and before the registry index is dropped.
 */
const deleteAccount = Effect.gen(function* () {
  const { principal } = yield* AccessPrincipal;

  if (principal.kind !== "user")
    return yield* replyError(403, "person_required", {
      message: "only a person can delete their account, not a service token",
    });

  const body = yield* bodyObject;
  const confirmed = body["email"];

  if (Object.keys(body).some((key) => key !== "email") || typeof confirmed !== "string")
    return yield* replyError(400, "invalid body");

  const email = principal.email.trim().toLowerCase();

  if (confirmed.trim().toLowerCase() !== email)
    return yield* replyError(422, "email_mismatch", {
      message: "type your own email address to confirm that your account is deleted",
    });

  const env = yield* WorkerEnv;
  const now = yield* Clock.currentTimeMillis;
  const orgs = yield* registry("orgsOfEmail", (stub) => stub.orgsOfEmail(email));

  const standings = yield* Effect.forEach(orgs, (org) =>
    Effect.tryPromise({
      try: async () => await controlPlaneOf(env, org.id).accountStanding(email),
      catch: () => replyError(502, "control plane unavailable"),
    }).pipe(Effect.map((standing) => ({ org, standing }))),
  );

  const blocking = standings.filter(({ standing }) => standing.soleOwner);

  if (blocking.length > 0)
    return yield* replyError(409, "sole_owner", {
      message:
        "you are the only owner of an org with other members: hand it over to another member first",
      orgs: blocking.map(({ org }) => org.slug),
    });

  const deleted: string[] = [];
  const left: string[] = [];

  for (const { org, standing } of standings) {
    if (standing.alone && org.id !== GLOBAL_ORG) {
      const outcome = yield* Effect.tryPromise({
        try: async () => await deleteOrgData(env, org.id, { now }),
        catch: (cause) => new DeletionThrew({ cause }),
      }).pipe(Effect.catch(deletionFailed(org.id)));

      forgetOrgProxyKeys(org.id);

      if (outcome.state === "incomplete")
        return yield* replyError(503, "deletion_incomplete", {
          message: "an org of yours still holds data; send the request again",
        });
      deleted.push(org.slug);
    } else if (standing.member) {
      yield* Effect.tryPromise({
        try: async () => await controlPlaneOf(env, org.id).leaveOrg(email),
        catch: () => replyError(502, "control plane unavailable"),
      });
      yield* syncOrgIndex(org.id);
      left.push(org.slug);
    }
  }

  yield* registry("removePerson", (stub) => stub.removePerson(email));

  return jsonReply(200, { deleted: true, orgs_left: left, orgs_deleted: deleted });
});

export const orgRoutes = [
  HttpRouter.route("DELETE", `${BASE}/me`, handled(deleteAccount)),
  HttpRouter.route("GET", `${BASE}/export`, handled(exportOrg)),
  HttpRouter.route("DELETE", `${BASE}/org`, handled(deleteOrgRoute)),
  HttpRouter.route("GET", `${BASE}/org`, handled(own)),
  HttpRouter.route("PATCH", `${BASE}/org`, handled(updateSettings)),
  HttpRouter.route("GET", `${BASE}/me`, handled(me)),
  HttpRouter.route("GET", `${BASE}/orgs`, handled(list)),
  HttpRouter.route("POST", `${BASE}/orgs`, handled(create)),
  HttpRouter.route("PATCH", `${BASE}/orgs/:slug`, handled(update)),
];
