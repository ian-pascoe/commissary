/**
 * `GET|PATCH /v9/management/people/:email` (`PeopleGroup` in @commissary/contract/people): the people of Commissary
 * Cloud (ADR 0026) as platform admins manage them: the owned-org limit, raisable per person, and suspension, which
 * signs the person out and refuses their sessions, API keys and management keys until it is lifted. Nothing is deleted.
 * A self-hosted Commissary has no such routes. Workers addition, no Go counterpart.
 */
import { Clock, Effect } from "effect";
import { HttpRouter } from "effect/http";
import { AccessPrincipal } from "../access/principal.ts";
import { hostedOnly } from "../hosted/only.ts";
import { endSessions } from "../hosted/session.ts";
import { forgetStanding, ownedOrgLimit } from "../hosted/standing.ts";
import { MAX_ORG_LIMIT, type PersonRecord } from "../platform/registry-store.ts";
import type { PersonView } from "@commissary/contract/people";
import { handled, jsonReply, replyError } from "@commissary/core";
import { bodyObject } from "./http.ts";
import { registry } from "./org-routes.ts";
import { AppEnv } from "../worker-env.ts";

const BASE = "/v9/management";

/** Loose like the member routes' check: something@something.something, no spaces. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const view = (person: PersonRecord): PersonView => ({
  email: person.email,
  ...(person.signedUpAt === undefined
    ? {}
    : { signed_up_at: new Date(person.signedUpAt).toISOString() }),
  org_limit: person.orgLimit,
  org_limit_set: person.orgLimitSet,
  owned_orgs: person.ownedOrgs,
  suspended: person.suspendedAt !== undefined,
});

/** The person of the path, after the hosted and platform admin checks. */
const addressed = Effect.gen(function* () {
  const env = yield* AppEnv;
  const identity = yield* AccessPrincipal;

  if (!identity.platformAdmin)
    return yield* replyError(403, "platform_admin_required", {
      message: "only a platform admin can manage people",
    });
  const { email } = yield* HttpRouter.params;
  const address = (email ?? "").trim().toLowerCase();

  if (!EMAIL.test(address)) return yield* replyError(422, "invalid_email");

  return { env, email: address };
});

const get = Effect.gen(function* () {
  const { env, email } = yield* addressed;
  const person = yield* registry("person", (stub) => stub.person(email, ownedOrgLimit(env)));

  return jsonReply(200, view(person));
});

const update = Effect.gen(function* () {
  const { env, email } = yield* addressed;
  const body = yield* bodyObject;
  const { org_limit: orgLimit, suspended, ...rest } = body;

  if (Object.keys(rest).length > 0 || (orgLimit === undefined && suspended === undefined))
    return yield* replyError(400, "invalid body");

  if (suspended !== undefined && typeof suspended !== "boolean")
    return yield* replyError(400, "invalid body");

  if (
    orgLimit !== undefined &&
    orgLimit !== null &&
    (typeof orgLimit !== "number" ||
      !Number.isSafeInteger(orgLimit) ||
      orgLimit < 0 ||
      orgLimit > MAX_ORG_LIMIT)
  )
    return yield* replyError(422, "invalid_org_limit", {
      message: `an org limit is a whole number from 0 to ${MAX_ORG_LIMIT}, or null for the default`,
    });
  const now = yield* Clock.currentTimeMillis;

  const person = yield* registry("updatePerson", (stub) =>
    stub.updatePerson(
      email,
      {
        ...(orgLimit === undefined ? {} : { orgLimit }),
        ...(suspended === undefined ? {} : { suspended }),
      },
      now,
      ownedOrgLimit(env),
    ),
  );

  forgetStanding({ email });

  if (suspended === true) {
    const ended = yield* endSessions(env, [email]);

    yield* Effect.logInfo("person suspended").pipe(Effect.annotateLogs({ sessionsEnded: ended }));
  }

  return jsonReply(200, view(person));
});

export const peopleRoutes = [
  HttpRouter.route("GET", `${BASE}/people/:email`, hostedOnly(handled(get))),
  HttpRouter.route("PATCH", `${BASE}/people/:email`, hostedOnly(handled(update))),
];
