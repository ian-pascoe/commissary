/**
 * The app Worker's side of Commissary Cloud's sign-in (ADR 0026, ADR 0030): Better Auth runs in the auth Worker, on the
 * auth host, and the app Worker asks it over its Cloud-only service binding (`AUTH`, typed by `@commissary/auth`'s
 * `SignInService`) who a session belongs to (the gate's `SignInSessions` port) and to end sessions or delete a sign-in
 * account. A self-hosted Commissary has no binding and makes none of these calls. New in the Workers port.
 */
import { Effect } from "effect";
import { SignInSessions, type SignInService } from "@commissary/auth";
import { AppEnv, type AppBindings } from "../worker-env.ts";

/**
 * The auth host's origin (`AUTH_ORIGIN`): where the sign-in page sends its requests and the orgs' identity providers
 * send people back. `undefined` when it is not an http(s) origin (a misconfigured deployment of Commissary Cloud).
 */
export const authOriginOf = (env: Pick<AppBindings, "AUTH_ORIGIN">): string | undefined => {
  const value = env.AUTH_ORIGIN?.trim() ?? "";

  try {
    const url = new URL(value);

    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value
      ? url.origin
      : undefined;
  } catch {
    return undefined;
  }
};

/** The auth Worker is not bound: a deployment of Commissary Cloud without it is misconfigured. */
const NOT_BOUND = "the auth Worker is not bound (AUTH)";

/** Calls the auth Worker `auth`; fails when it is not bound or the call fails. */
const callAuth = <A>(
  auth: SignInService | undefined,
  call: (auth: SignInService) => Promise<A>,
): Effect.Effect<A, Error> =>
  auth === undefined
    ? Effect.fail(new Error(NOT_BOUND))
    : Effect.tryPromise({
        try: async () => await call(auth),
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      });

/** Calls the auth Worker the invocation binds. */
const ask = <A>(call: (auth: SignInService) => Promise<A>): Effect.Effect<A, Error, AppEnv> =>
  Effect.gen(function* () {
    return yield* callAuth((yield* AppEnv).AUTH, call);
  });

/**
 * The gate's port to the auth Worker's sessions (`SignInSessions`), over the invocation's bindings: a failed lookup is
 * logged and counts as no session.
 */
export const signInSessions = (env: Pick<AppBindings, "AUTH">): SignInSessions["Service"] =>
  SignInSessions.of({
    person: (cookie) =>
      callAuth(env.AUTH, async (auth) => await auth.session(cookie)).pipe(
        Effect.map((person) => person ?? undefined),
        Effect.catch((error) =>
          Effect.logWarning(`session lookup failed: ${error.message}`).pipe(Effect.as(undefined)),
        ),
      ),
  });

/**
 * Ends every session of the people with these emails (a suspension): their next request is not signed in. Answers how
 * many sessions it ended; a failure is logged and ends none.
 */
export const endSessions = (emails: ReadonlyArray<string>): Effect.Effect<number, never, AppEnv> =>
  emails.length === 0
    ? Effect.succeed(0)
    : ask(async (auth) => await auth.endSessions(emails)).pipe(
        Effect.catch((error) =>
          Effect.logError(`sessions not ended: ${error.message}`).pipe(Effect.as(0)),
        ),
      );

/** Ends every session of the people whose email is at `domain`: answers how many it ended; a failure fails. */
export const endDomainSessions = (domain: string): Effect.Effect<number, Error, AppEnv> =>
  ask(async (auth) => await auth.endDomainSessions(domain));

/** Deletes the sign-in account of `email`: answers how many accounts it deleted; a failure fails. */
export const deleteSignInAccount = (email: string): Effect.Effect<number, Error, AppEnv> =>
  ask(async (auth) => await auth.deleteSignInAccount(email));
