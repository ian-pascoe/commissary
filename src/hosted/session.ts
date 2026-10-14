/**
 * The person a hosted proxy's request comes from (ADR 0026): Better Auth's session cookie, read on every request, so a
 * session ended by sign-out or suspension stops working at once. New in the Workers port.
 */
import { Effect } from "effect";
import { hostedAuth, type HostedAuth } from "./auth.ts";

type SessionEnv = Parameters<typeof hostedAuth>[0];

/** The deployment's Better Auth instance. */
export const signedInAuth = (env: SessionEnv, origin: string): Promise<HostedAuth> =>
  hostedAuth(env, origin);

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
