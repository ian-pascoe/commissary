/**
 * Better Auth's sessions on Commissary Cloud (ADR 0026, ADR 0030): the instance the auth Worker runs, with the hooks
 * that reach the orgs and the Platform registry through `AuthDirectory`, and what the auth Worker's RPC
 * (`SignInService`, `@commissary/auth`) does with the `SignIn` database: who a session belongs to, ending sessions,
 * deleting a sign-in account. Only this Worker binds that database (#130). New in the Workers port.
 */
import { Effect } from "effect";
import {
  AuthDirectory,
  type AuthDirectoryService,
  ensureSignedUp,
  type SignedInPerson,
  type SsoAdmission,
  SUSPENDED,
  syncOrgIndex,
} from "@commissary/auth";
import { betterAuthProvider, emailDomain, orgOfProviderId } from "@commissary/auth/sso";
import {
  appOriginOf,
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
const ssoProvider =
  (directory: AuthDirectoryService, origin: string, appOrigin: string) =>
  async (providerId: string) => {
    const org = orgOfProviderId(providerId);

    if (org === undefined) return undefined;

    const [state, held] = await Effect.runPromise(
      Effect.all([directory.ssoState(org), directory.ssoDomainsOf(org)], { concurrency: 2 }),
    );

    if (state.provider === undefined) return undefined;
    const registered = new Set(held);

    const verified = state.domains
      .filter((domain) => domain.verifiedAt !== undefined && registered.has(domain.domain))
      .map((domain) => domain.domain);

    return betterAuthProvider(origin, org, state.provider.settings, verified, `${appOrigin}/`);
  };

/**
 * Admits a person the org's identity provider signed in: the registry must give their email's domain to that org, and
 * the org's ControlPlane makes them a member (`ControlPlane.admitThroughSso`), then the registry's index learns it
 * before their session starts (so the sign-up does not give them a Personal org instead, `@commissary/auth`
 * `ensureSignedUp`).
 */
const admitThroughSso =
  (directory: AuthDirectoryService) =>
  async (providerId: string, email: string): Promise<SignInRefusal | undefined> => {
    const org = orgOfProviderId(providerId);
    const domain = emailDomain(email);

    if (org === undefined || domain === undefined) return SSO_REFUSALS.domain_unverified;

    if ((await Effect.runPromise(directory.ssoDomain(domain)))?.org !== org)
      return SSO_REFUSALS.domain_unverified;
    const admission = await Effect.runPromise(directory.admitThroughSso(org, email));

    if (!admission.ok) return SSO_REFUSALS[admission.error];

    if (admission.joined || admission.indexStale)
      await Effect.runPromise(
        syncOrgIndex(org).pipe(Effect.provideService(AuthDirectory, directory)),
      );

    return undefined;
  };

/**
 * Signs the person up before their session starts (#132: once, here, rather than on their requests to the app Worker):
 * `false` for a suspended person, whose session must not start; any other failure fails the sign-in, which they retry.
 */
const signUp =
  (directory: AuthDirectoryService) =>
  async (email: string): Promise<boolean> =>
    await Effect.runPromise(
      ensureSignedUp(email).pipe(
        Effect.as(true),
        Effect.catchTag("ForbiddenError", (error) =>
          error.message === SUSPENDED ? Effect.succeed(false) : Effect.fail(error),
        ),
        Effect.provideService(AuthDirectory, directory),
      ),
    );

/**
 * The deployment's Better Auth instance at `origin` (the auth host): a sign-in signs the person up and a suspended
 * person cannot start a session; the orgs' identity providers sign people in, and GitHub or Google cannot for a domain
 * that requires single sign-on.
 */
export const signedInAuth = (
  env: SignInBindings,
  directory: AuthDirectoryService,
  origin: string,
): Promise<HostedAuth> =>
  hostedAuth(env, origin, {
    signUp: signUp(directory),
    ssoProvider: ssoProvider(directory, origin, appOriginOf(env) ?? ""),
    admitThroughSso: admitThroughSso(directory),
    ssoRequired: async (email) => {
      const domain = emailDomain(email);

      return (
        domain !== undefined &&
        (await Effect.runPromise(directory.ssoDomain(domain)))?.requireSso === true
      );
    },
  });

/**
 * Ends every session of the people with these emails (a suspension): their next request is not signed in. Their
 * accounts stay: nothing is deleted. Answers how many sessions it ended; a D1 failure rejects.
 */
export const endSessions = async (
  env: Pick<SignInBindings, "SIGN_IN">,
  emails: ReadonlyArray<string>,
): Promise<number> => {
  const unique = [...new Set(emails.map((email) => email.toLowerCase()))];
  let ended = 0;

  // D1 binds at most 100 parameters per statement.
  for (let start = 0; start < unique.length; start += 90) {
    const batch = unique.slice(start, start + 90);

    const result = await env.SIGN_IN.prepare(
      `DELETE FROM "session" WHERE "userId" IN
         (SELECT id FROM "user" WHERE lower(email) IN (${batch.map(() => "?").join(", ")}))`,
    )
      .bind(...batch)
      .run();

    ended += result.meta.changes;
  }

  return ended;
};

/**
 * Ends every session of the people whose email is at `domain` (its org started requiring single sign-on for it): they
 * sign in again, through the org's identity provider. Answers how many sessions it ended; a D1 failure rejects.
 */
export const endDomainSessions = async (
  env: Pick<SignInBindings, "SIGN_IN">,
  domain: string,
): Promise<number> => {
  // A normalized domain (`@commissary/auth/sso` `normalizeDomain`) holds only letters, digits, `-` and `.`: nothing `LIKE` treats specially.
  const result = await env.SIGN_IN.prepare(
    `DELETE FROM "session" WHERE "userId" IN
       (SELECT id FROM "user" WHERE lower(email) LIKE ?)`,
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
  env: Pick<SignInBindings, "SIGN_IN">,
  email: string,
): Promise<number> => {
  const address = email.toLowerCase();
  const ofUser = `"userId" IN (SELECT id FROM "user" WHERE lower(email) = ?)`;

  // One batch is one transaction: the sessions and accounts go with the user, whether or not D1 enforces the cascade.
  const [, , users] = await env.SIGN_IN.batch([
    env.SIGN_IN.prepare(`DELETE FROM "session" WHERE ${ofUser}`).bind(address),
    env.SIGN_IN.prepare(`DELETE FROM "account" WHERE ${ofUser}`).bind(address),
    env.SIGN_IN.prepare(`DELETE FROM "user" WHERE lower(email) = ?`).bind(address),
  ]);

  return users?.meta.changes ?? 0;
};

/**
 * The person whose live session `cookie` names; `undefined` without one, for an expired or ended session, and for an
 * email the provider has not verified (Better Auth never creates those, `auth.ts`). `origin` is the auth host's.
 */
export const signedInPerson = async (
  env: SignInBindings,
  directory: AuthDirectoryService,
  origin: string,
  cookie: string,
): Promise<SignedInPerson | undefined> => {
  if (cookie === "") return undefined;
  const auth = await signedInAuth(env, directory, origin);
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) });

  if (session === null || !session.user.emailVerified) return undefined;

  return { userId: session.user.id, email: session.user.email.toLowerCase() };
};
