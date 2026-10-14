/**
 * The person a hosted proxy's request comes from (ADR 0026): Better Auth's session cookie, read on every request, so a
 * session ended by sign-out or suspension stops working at once. New in the Workers port.
 */
import { Effect } from "effect";
import { GLOBAL_ORG } from "../platform/org.ts";
import { platformOf } from "../platform/registry.ts";
import { AUTH_TABLES, hostedAuth, type HostedAuth } from "./auth.ts";

type SessionEnv = Env;

/** The deployment's Better Auth instance; a suspended person cannot start a session. */
export const signedInAuth = (env: SessionEnv, origin: string): Promise<HostedAuth> =>
  hostedAuth(env, origin, {
    maySignIn: async (email) =>
      (await platformOf(env).standing(GLOBAL_ORG, email)).person !== "suspended",
  });

/**
 * Ends every session of the people with these emails (a suspension): their next request is not signed in. Their
 * accounts stay: nothing is deleted.
 */
export const endSessions = (
  env: Pick<Env, "USAGE">,
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
 * Deletes the sign-in account of `email` (a person deleting their account, ADR 0027): Better Auth's user with its
 * sessions and linked GitHub/Google accounts, so their cookie stops working at once. Answers how many users it deleted
 * (0 once it is gone, so a repeated deletion succeeds); a D1 failure rejects.
 */
export const deleteSignInAccount = async (
  env: Pick<Env, "USAGE">,
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
  env: SessionEnv,
  origin: string,
  headers: Readonly<Record<string, string | undefined>>,
): Effect.Effect<SignedInPerson | undefined> => {
  const cookie = headers["cookie"] ?? "";

  if (cookie === "") return Effect.succeed(undefined);

  return Effect.tryPromise(async () => {
    const auth = await signedInAuth(env, origin);

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
