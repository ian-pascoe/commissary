// Helpers for Commissary Cloud tests (vitest project `hosted`, vitest.config.ts): requests to the app host
// `https://commissary.test` and sessions of the fake auth Worker (test/worker.ts `FakeSignIn`). A sign-in here signs the
// person up the way the auth Worker does before their session starts (`ensureSignedUp`, `@commissary/auth`); Better
// Auth's own flow is the auth Worker's, tested there (apps/auth/test/).
import { env, exports } from "cloudflare:workers";
import { Effect } from "effect";
import { AuthDirectory, ensureSignedUp } from "@commissary/auth";
import { stateAuthDirectory } from "@commissary/state";
import { resetUsageDb } from "@commissary/models/testing";
import { FAKE_ACCOUNT_PREFIX, FAKE_SESSION_COOKIE, FAKE_SESSION_PREFIX } from "../worker.ts";

export const ORIGIN = "https://commissary.test";

/** The auth host the app Worker names (`AUTH_ORIGIN`, vitest.config.ts). */
export const AUTH_ORIGIN = "https://auth.commissary.test";

/** Who signs in. */
export interface Person {
  readonly email: string;
}

const realFetch = globalThis.fetch;

/** Empties the usage database and the fake's sessions (call in `beforeAll`); {@link restoreFetch} undoes stubs. */
export const installFakes = async (): Promise<void> => {
  await resetUsageDb();
  await clearPeople();
};

/** Puts back the global `fetch` a test file replaced. */
export const restoreFetch = (): void => {
  globalThis.fetch = realFetch;
};

/** Ends every session and forgets every sign-in account of the fake auth Worker. */
export const clearPeople = async (): Promise<void> => {
  for (const prefix of [FAKE_SESSION_PREFIX, FAKE_ACCOUNT_PREFIX]) {
    const { keys } = await env.CACHE.list({ prefix });

    for (const { name } of keys) await env.CACHE.delete(name);
  }
};

/** A request to the app host; redirects are returned, not followed. */
export const call = (path: string, init?: RequestInit): Promise<Response> =>
  exports.default.fetch(new Request(`${ORIGIN}${path}`, { redirect: "manual", ...init }));

/**
 * Signs `person` in as the auth Worker does: signs them up (a Personal org unless they were invited) and starts a
 * session; the session cookie for later requests, empty when the sign-in was refused (a suspended person).
 */
export const signIn = async (person: Person): Promise<string> => {
  const email = person.email.toLowerCase();

  const signedUp = await Effect.runPromise(
    ensureSignedUp(email).pipe(
      Effect.as(true),
      Effect.catchTag("ForbiddenError", () => Effect.succeed(false)),
      Effect.provideService(AuthDirectory, stateAuthDirectory(env)),
    ),
  );

  if (!signedUp) return "";
  const token = crypto.randomUUID();

  await env.CACHE.put(`${FAKE_ACCOUNT_PREFIX}${email}`, "1");
  await env.CACHE.put(
    `${FAKE_SESSION_PREFIX}${token}`,
    JSON.stringify({ userId: `user-${email}`, email }),
  );

  return `${FAKE_SESSION_COOKIE}=${token}`;
};

/** What the fake auth Worker keeps of `email`: its sign-in account and sessions. */
export const signInRowsOf = async (email: string) => {
  const address = email.toLowerCase();
  const { keys } = await env.CACHE.list({ prefix: FAKE_SESSION_PREFIX });
  let sessions = 0;

  for (const { name } of keys)
    if ((await env.CACHE.get<{ email: string }>(name, "json"))?.email === address) sessions += 1;

  return {
    accounts: (await env.CACHE.get(`${FAKE_ACCOUNT_PREFIX}${address}`)) === null ? 0 : 1,
    sessions,
  };
};

/** Headers of a same-origin panel request with `cookie`. */
export const panelHeaders = (cookie: string, extra: Record<string, string> = {}) => ({
  cookie,
  origin: ORIGIN,
  "sec-fetch-site": "same-origin",
  ...extra,
});
