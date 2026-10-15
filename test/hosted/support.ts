// Helpers for Commissary Cloud tests (vitest project `hosted`, vitest.config.ts): requests to `https://proxy.test`, a
// fake GitHub and Turnstile behind the global `fetch`, and a sign-in that walks Better Auth's real GitHub flow.
import { exports } from "cloudflare:workers";
import { SITEVERIFY_URL } from "../../src/hosted/turnstile.ts";
import { resetUsageDb } from "../support/usage.ts";

export const ORIGIN = "https://proxy.test";

/** The Turnstile token the fake siteverify accepts; any other token fails. */
export const GOOD_TURNSTILE = "turnstile-ok";

/** A token the fake siteverify accepts but reports as issued on another site's widget. */
export const OTHER_SITE_TURNSTILE = "turnstile-other-site";

/** Who the fake GitHub signs in next, and whether it verified their email. */
export interface GitHubPerson {
  readonly email: string;
  readonly verified?: boolean;
  /** GitHub's numeric user id; derived from the email by default. */
  readonly id?: number;
}

interface FakeUpstreams {
  person: GitHubPerson;
  /** siteverify answers 500 while set. */
  turnstileDown: boolean;
  /** Bodies siteverify received. */
  siteverify: Array<Record<string, unknown>>;
  /** Calls the fake answered with 599 (nothing should reach them). */
  unexpected: Array<string>;
}

export const upstreams: FakeUpstreams = {
  person: { email: "ada@example.com" },
  turnstileDown: false,
  siteverify: [],
  unexpected: [],
};

const idOf = (email: string): number =>
  Array.from(email, (char) => char.charCodeAt(0)).reduce(
    (hash, code) => (hash * 31 + code) % 1_000_000_007,
    7,
  );

const realFetch = globalThis.fetch;

/** Installs the fake upstreams (call in `beforeAll`) and empties the D1 tables; {@link restoreFetch} undoes it. */
export const installFakes = async (): Promise<void> => {
  await resetUsageDb();
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = request.url;

    if (url === SITEVERIFY_URL) {
      // The Worker sends siteverify a JSON object (src/hosted/turnstile.ts).
      const body = await request.json<Record<string, unknown>>();
      upstreams.siteverify.push(body);

      if (upstreams.turnstileDown) return new Response("down", { status: 500 });

      if (body["response"] === OTHER_SITE_TURNSTILE)
        return Response.json({ success: true, hostname: "elsewhere.example" });

      return Response.json({
        success: body["response"] === GOOD_TURNSTILE,
        hostname: new URL(ORIGIN).hostname,
      });
    }

    if (url.startsWith("https://github.com/login/oauth/access_token"))
      return Response.json({ access_token: "gho_test", token_type: "bearer", scope: "user:email" });

    const { email, verified = true, id = idOf(email) } = upstreams.person;

    if (url === "https://api.github.com/user")
      return Response.json({ id, login: email.split("@")[0], name: email, email, avatar_url: "" });

    if (url === "https://api.github.com/user/emails")
      return Response.json([{ email, primary: true, verified, visibility: "public" }]);

    upstreams.unexpected.push(url);

    return new Response(`unexpected ${url}`, { status: 599 });
  };

  // Loads Better Auth (imported lazily by the Worker) here, under the hook timeout, rather than in the first test.
  await call("/api/auth/get-session");
};

export const restoreFetch = (): void => {
  globalThis.fetch = realFetch;
};

/** Clears the D1 auth tables between tests (people and sessions). */
export const clearPeople = async (): Promise<void> => {
  const db = await resetUsageDb();

  for (const table of ["auth_session", "auth_account", "auth_verification", "auth_user"])
    await db.prepare(`DELETE FROM ${table}`).run();
};

/** A request to the hosted Worker; redirects are returned, not followed. */
export const call = (path: string, init?: RequestInit): Promise<Response> =>
  exports.default.fetch(new Request(`${ORIGIN}${path}`, { redirect: "manual", ...init }));

/** The `name=value` pairs of a response's cookies, joined for a `Cookie` header. */
export const cookiesOf = (response: Response): string =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0] ?? "")
    .filter((pair) => pair !== "" && !pair.endsWith("="))
    .join("; ");

/** Starts a GitHub sign-in the way the sign-in page does: same origin, JSON, the Turnstile token in its header. */
export const startSignIn = (turnstile: string | null = GOOD_TURNSTILE): Promise<Response> =>
  call("/api/auth/sign-in/social", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      ...(turnstile === null ? {} : { "x-captcha-response": turnstile }),
    },
    body: JSON.stringify({ provider: "github", callbackURL: "/" }),
  });

/** GitHub sending the browser back: the callback with the state of `start` and its cookies. */
export const finishSignIn = async (start: Response): Promise<Response> => {
  // Better Auth answers a started social sign-in with `{url, redirect}`.
  const { url } = await start.clone().json<{ url: string }>();
  const state = new URL(url).searchParams.get("state") ?? "";

  return call(`/api/auth/callback/github?code=code-1&state=${encodeURIComponent(state)}`, {
    headers: { cookie: cookiesOf(start), "sec-fetch-site": "cross-site" },
    redirect: "manual",
  });
};

/** Signs `person` in through GitHub; the session cookie for later requests (empty when the sign-in was refused). */
export const signIn = async (person: GitHubPerson): Promise<string> => {
  upstreams.person = person;
  const start = await startSignIn();

  if (start.status !== 200) throw new Error(`sign-in start answered ${start.status}`);

  return cookiesOf(await finishSignIn(start));
};

/** Headers of a same-origin panel request with `cookie`. */
export const panelHeaders = (cookie: string, extra: Record<string, string> = {}) => ({
  cookie,
  origin: ORIGIN,
  "sec-fetch-site": "same-origin",
  ...extra,
});
