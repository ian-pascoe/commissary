/**
 * The app Worker's side of Commissary Cloud's sign-in (ADR 0026, ADR 0030): Better Auth runs in the auth Worker, on the
 * auth host, and the app Worker asks it over its Cloud-only service binding (`AUTH`, typed by `@commissary/auth`'s
 * `SignInService`) who a session belongs to (the gate's `SignInSessions` port) and to end sessions or delete a sign-in
 * account. A self-hosted Commissary has no binding and makes none of these calls. New in the Workers port.
 */
import { Data, Effect } from "effect";
import { SignInSessions, type SignInService } from "@commissary/auth";
import { httpOrigin } from "@commissary/contract/sign-in";
import { InternalError } from "@commissary/core";
import { AppEnv, type AppBindings } from "../worker-env.ts";

/**
 * The auth host's origin (`AUTH_ORIGIN`): where the sign-in page sends its requests and the orgs' identity providers
 * send people back. Logged and `undefined` when it is not an http(s) origin (a misconfigured Commissary Cloud).
 */
export const configuredAuthOrigin: Effect.Effect<string | undefined, never, AppEnv> = Effect.gen(
  function* () {
    const origin = httpOrigin((yield* AppEnv).AUTH_ORIGIN);

    if (origin === undefined)
      yield* Effect.logError(
        "hosted sign-in is not configured: AUTH_ORIGIN is missing or not an origin",
      );

    return origin;
  },
);

/** A call to the auth Worker failed, or it is not bound (a deployment of Commissary Cloud without it is misconfigured). */
export class SignInCallFailed extends Data.TaggedError("SignInCallFailed")<{
  readonly message: string;
}> {}

/** Calls the auth Worker `auth`; fails when it is not bound or the call fails. */
const callAuth = <A>(
  auth: SignInService | undefined,
  call: (auth: SignInService) => Promise<A>,
): Effect.Effect<A, SignInCallFailed> =>
  auth === undefined
    ? Effect.fail(new SignInCallFailed({ message: "the auth Worker is not bound (AUTH)" }))
    : Effect.tryPromise({
        try: async () => await call(auth),
        catch: (cause) =>
          new SignInCallFailed({ message: cause instanceof Error ? cause.message : String(cause) }),
      });

/** Calls the auth Worker the invocation binds. */
const ask = Effect.fnUntraced(function* <A>(
  call: (auth: SignInService) => Promise<A>,
): Effect.fn.Return<A, SignInCallFailed, AppEnv> {
  return yield* callAuth((yield* AppEnv).AUTH, call);
});

/**
 * The gate's port to the auth Worker's sessions (`SignInSessions`), over the invocation's bindings. A failed lookup
 * fails the request (a 500): it does not turn the person away as signed out.
 */
export const signInSessions = (env: Pick<AppBindings, "AUTH">): SignInSessions["Service"] =>
  SignInSessions.of({
    person: (cookie) =>
      callAuth(env.AUTH, async (auth) => await auth.session(cookie)).pipe(
        Effect.map((person) => person ?? undefined),
        Effect.mapError(
          (error) => new InternalError({ message: `session lookup failed: ${error.message}` }),
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
export const endDomainSessions = (
  domain: string,
): Effect.Effect<number, SignInCallFailed, AppEnv> =>
  ask(async (auth) => await auth.endDomainSessions(domain));

/** Deletes the sign-in account of `email`: answers how many accounts it deleted; a failure fails. */
export const deleteSignInAccount = (
  email: string,
): Effect.Effect<number, SignInCallFailed, AppEnv> =>
  ask(async (auth) => await auth.deleteSignInAccount(email));
