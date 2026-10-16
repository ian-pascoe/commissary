/**
 * The person Commissary Cloud's request comes from (ADR 0026): Better Auth's session cookie, read on every request, so a
 * session ended by sign-out or suspension stops working at once. New in the Workers port.
 */
import { Effect } from "effect";
import { syncOrgIndex } from "../members/admission.ts";
import { GLOBAL_ORG } from "@commissary/core";
import { controlPlaneOf } from "../platform/org.ts";
import { platformOf } from "../platform/registry.ts";
import { emailDomain } from "../sso/domain.ts";
import { betterAuthProvider, orgOfProviderId } from "../sso/provider.ts";
import { type StateBindings, StateEnv } from "../state/env.ts";
import type { SsoAdmission } from "../sso/store.ts";
import {
  AUTH_TABLES,
  hostedAuth,
  type HostedAuth,
  type SignInBindings,
  type SignInRefusal,
} from "./auth.ts";

/** Why a sign-in through an org's identity provider was refused, as the sign-in page shows it. */
const SSO_REFUSALS: Readonly<Record<Exclude<SsoAdmission, { ok: true }>["error"], SignInRefusal>> =
  {
    provider_missing: {
      error: "sso_unavailable",
      errorDescription: "Your organization no longer signs in with this identity provider.",
    },
    domain_unverified: {
      error: "sso_domain_unverified",
      errorDescription: "Your email's domain is not one your organization has verified.",
    },
    removed: {
      error: "sso_removed",
      errorDescription:
        "An admin removed you from this organization; ask them to add you again before you sign in.",
    },
  };

/**
 * The identity provider of the org `providerId` names, as Better Auth's SSO plugin reads it: with the domains the org
 * verified that the Platform registry also gives it (one org per domain), `undefined` without one.
 */
const ssoProvider = (env: StateBindings, origin: string) => async (providerId: string) => {
  const org = orgOfProviderId(providerId);

  if (org === undefined) return undefined;

  const [state, held] = await Promise.all([
    controlPlaneOf(env, org).ssoState(),
    platformOf(env).ssoDomainsOf(org),
  ]);

  if (state.provider === undefined) return undefined;
  const registered = new Set(held);

  const verified = state.domains
    .filter((domain) => domain.verifiedAt !== undefined && registered.has(domain.domain))
    .map((domain) => domain.domain);

  return betterAuthProvider(origin, org, state.provider.settings, verified);
};

/**
 * Admits a person the org's identity provider signed in: the registry must give their email's domain to that org, and
 * the org's ControlPlane makes them a member (`ControlPlane.admitThroughSso`), then the registry's index learns it
 * before their session starts (so the sign-up does not give them a Personal org instead, `standing.ts`).
 */
const admitThroughSso =
  (env: StateBindings) =>
  async (providerId: string, email: string): Promise<SignInRefusal | undefined> => {
    const org = orgOfProviderId(providerId);
    const domain = emailDomain(email);

    if (org === undefined || domain === undefined) return SSO_REFUSALS.domain_unverified;

    if ((await platformOf(env).ssoDomain(domain))?.org !== org)
      return SSO_REFUSALS.domain_unverified;
    const admission = await controlPlaneOf(env, org).admitThroughSso(email);

    if (!admission.ok) return SSO_REFUSALS[admission.error];

    if (admission.joined || admission.indexStale)
      await Effect.runPromise(syncOrgIndex(org).pipe(Effect.provideService(StateEnv, env)));

    return undefined;
  };

/**
 * The deployment's Better Auth instance: a suspended person cannot start a session; the orgs' identity providers sign
 * people in, and GitHub or Google cannot for a domain that requires single sign-on.
 */
export const signedInAuth = (
  env: SignInBindings,
  state: StateBindings,
  origin: string,
): Promise<HostedAuth> =>
  hostedAuth(env, origin, {
    maySignIn: async (email) =>
      (await platformOf(state).standing(GLOBAL_ORG, email)).person !== "suspended",
    ssoProvider: ssoProvider(state, origin),
    admitThroughSso: admitThroughSso(state),
    ssoRequired: async (email) => {
      const domain = emailDomain(email);

      return (
        domain !== undefined && (await platformOf(state).ssoDomain(domain))?.requireSso === true
      );
    },
  });

/**
 * Ends every session of the people with these emails (a suspension): their next request is not signed in. Their
 * accounts stay: nothing is deleted.
 */
export const endSessions = (
  env: Pick<SignInBindings, "USAGE">,
  emails: ReadonlyArray<string>,
): Effect.Effect<number> => {
  const unique = [...new Set(emails.map((email) => email.toLowerCase()))];

  if (unique.length === 0) return Effect.succeed(0);

  return Effect.tryPromise(async () => {
    let ended = 0;

    // D1 binds at most 100 parameters per statement.
    for (let start = 0; start < unique.length; start += 90) {
      const batch = unique.slice(start, start + 90);

      const result = await env.USAGE.prepare(
        `DELETE FROM ${AUTH_TABLES.session} WHERE "userId" IN
           (SELECT id FROM ${AUTH_TABLES.user} WHERE lower(email) IN (${batch.map(() => "?").join(", ")}))`,
      )
        .bind(...batch)
        .run();

      ended += result.meta.changes;
    }

    return ended;
  }).pipe(
    Effect.catch((error) =>
      Effect.logError(`sessions not ended: ${error.message}`).pipe(Effect.as(0)),
    ),
  );
};

/**
 * Ends every session of the people whose email is at `domain` (its org started requiring single sign-on for it): they
 * sign in again, through the org's identity provider. Answers how many sessions it ended; a D1 failure rejects.
 */
export const endDomainSessions = async (
  env: Pick<SignInBindings, "USAGE">,
  domain: string,
): Promise<number> => {
  // A normalized domain (`sso/domain.ts`) holds only letters, digits, `-` and `.`: nothing `LIKE` treats specially.
  const result = await env.USAGE.prepare(
    `DELETE FROM ${AUTH_TABLES.session} WHERE "userId" IN
       (SELECT id FROM ${AUTH_TABLES.user} WHERE lower(email) LIKE ?)`,
  )
    .bind(`%@${domain.toLowerCase()}`)
    .run();

  return result.meta.changes;
};

/**
 * Deletes the sign-in account of `email` (a person deleting their account, ADR 0027): Better Auth's user with its
 * sessions and linked GitHub/Google accounts, so their cookie stops working at once. Answers how many users it deleted
 * (0 once it is gone, so a repeated deletion succeeds); a D1 failure rejects.
 */
export const deleteSignInAccount = async (
  env: Pick<SignInBindings, "USAGE">,
  email: string,
): Promise<number> => {
  const address = email.toLowerCase();
  const ofUser = `"userId" IN (SELECT id FROM ${AUTH_TABLES.user} WHERE lower(email) = ?)`;

  // One batch is one transaction: the sessions and accounts go with the user, whether or not D1 enforces the cascade.
  const [, , users] = await env.USAGE.batch([
    env.USAGE.prepare(`DELETE FROM ${AUTH_TABLES.session} WHERE ${ofUser}`).bind(address),
    env.USAGE.prepare(`DELETE FROM ${AUTH_TABLES.account} WHERE ${ofUser}`).bind(address),
    env.USAGE.prepare(`DELETE FROM ${AUTH_TABLES.user} WHERE lower(email) = ?`).bind(address),
  ]);

  return users?.meta.changes ?? 0;
};

/** A signed-in person: Better Auth's user id and their email, which the provider verified. */
export interface SignedInPerson {
  readonly userId: string;
  /** Lowercased. */
  readonly email: string;
}

/**
 * The person whose live session the request's cookie names; `undefined` without one, for an expired or ended session,
 * and for an email the provider has not verified (Better Auth never creates those, `auth.ts`).
 */
export const signedInPerson = (
  env: SignInBindings,
  state: StateBindings,
  origin: string,
  headers: Readonly<Record<string, string | undefined>>,
): Effect.Effect<SignedInPerson | undefined> => {
  const cookie = headers["cookie"] ?? "";

  if (cookie === "") return Effect.succeed(undefined);

  return Effect.tryPromise(async () => {
    const auth = await signedInAuth(env, state, origin);

    const session = await auth.api.getSession({
      headers: new Headers({ cookie }),
    });

    if (session === null || !session.user.emailVerified) return undefined;

    return { userId: session.user.id, email: session.user.email.toLowerCase() };
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning(`session lookup failed: ${error.message}`).pipe(Effect.as(undefined)),
    ),
  );
};
