// Helpers for the auth Worker's tests (vitest.config.ts): requests to the auth host `https://auth.commissary.test` as
// the sign-in page on the app host `https://app.commissary.test` sends them (both under the base domain
// `commissary.test`, which scopes the session cookie: ADR 0031), a fake GitHub and Turnstile behind the global
// `fetch`, a sign-in that walks Better Auth's real GitHub flow, the RPC the app Worker calls, and orgs set up straight
// through the state Worker's objects (the routes that create them are the app Worker's).
import { env, exports } from "cloudflare:workers";
import { Effect } from "effect";
import { AuthDirectory, type SignInService, syncOrgIndex } from "@commissary/auth";
import { newOrgId, type OrgId } from "@commissary/core";
import { controlPlaneOf, platformOf, stateAuthDirectory } from "@commissary/state";
import signInMigration from "../../../migrations/sign-in/0001_better_auth.sql?raw";
import { SITEVERIFY_URL } from "../src/sign-in/turnstile.ts";

/** The auth host: Better Auth's routes and `/api/sign-in-options`. */
export const AUTH_ORIGIN = "https://auth.commissary.test";

/** The app host (`APP_ORIGIN`): the sign-in page and the panel, which call the auth host. */
export const APP_ORIGIN = "https://app.commissary.test";

/** The session cookie's name: scoped to the base domain above the app host, so named apart (ADR 0031). */
export const SESSION_COOKIE = "__Secure-commissary.session_token";

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

/** The statements of a migration file, comments dropped. */
export const statementsOf = (sql: string): string[] =>
  sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "");

/** Applies the `SignIn` database's migrations (idempotent) and empties its tables (people and sessions). */
export const clearPeople = async (): Promise<void> => {
  for (const statement of statementsOf(signInMigration)) await env.SIGN_IN.prepare(statement).run();

  for (const table of ["session", "account", "verification", "user"])
    await env.SIGN_IN.prepare(`DELETE FROM "${table}"`).run();
};

const realFetch = globalThis.fetch;

/** Installs the fake upstreams (call in `beforeAll`) and empties the D1 tables; {@link restoreFetch} undoes it. */
export const installFakes = async (): Promise<void> => {
  await clearPeople();
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = request.url;

    if (url === SITEVERIFY_URL) {
      // The Worker sends siteverify a JSON object (src/sign-in/turnstile.ts).
      const body = await request.json<Record<string, unknown>>();
      upstreams.siteverify.push(body);

      if (upstreams.turnstileDown) return new Response("down", { status: 500 });

      if (body["response"] === OTHER_SITE_TURNSTILE)
        return Response.json({ success: true, hostname: "elsewhere.example" });

      // The widget renders on the sign-in page, on the app host.
      return Response.json({
        success: body["response"] === GOOD_TURNSTILE,
        hostname: new URL(APP_ORIGIN).hostname,
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

/** A request to the auth host; redirects are returned, not followed. */
export const call = (path: string, init?: RequestInit): Promise<Response> =>
  exports.default.fetch(new Request(`${AUTH_ORIGIN}${path}`, { redirect: "manual", ...init }));

/** The auth Worker's RPC, as the app Worker's service binding calls it. */
// SAFETY: the test Worker's default export is the auth Worker's entrypoint (test/worker.ts), which implements it.
export const rpc = exports.default as unknown as SignInService;

/** Whose session `cookie` is, as the app Worker asks over the RPC; `null` when it is no live session. */
export const sessionOf = async (cookie: string) => await rpc.session(cookie);

/** The `name=value` pairs of a response's cookies, joined for a `Cookie` header. */
export const cookiesOf = (response: Response): string =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0] ?? "")
    .filter((pair) => pair !== "" && !pair.endsWith("="))
    .join("; ");

/** Headers of a write the sign-in page on the app host sends the auth host. */
export const fromApp = (extra: Record<string, string> = {}) => ({
  "content-type": "application/json",
  origin: APP_ORIGIN,
  "sec-fetch-site": "same-site",
  ...extra,
});

/** Starts a sign-in with `provider` the way the sign-in page does: from the app host, JSON, the Turnstile token. */
export const startSocial = (
  provider: "github" | "google",
  turnstile: string | null = GOOD_TURNSTILE,
): Promise<Response> =>
  call("/api/auth/sign-in/social", {
    method: "POST",
    headers: fromApp(turnstile === null ? {} : { "x-captcha-response": turnstile }),
    body: JSON.stringify({ provider, callbackURL: `${APP_ORIGIN}/` }),
  });

/** Starts a GitHub sign-in the way the sign-in page does. */
export const startSignIn = (turnstile: string | null = GOOD_TURNSTILE): Promise<Response> =>
  startSocial("github", turnstile);

/** The provider sending the browser back: the callback with the state of `start` and its cookies. */
export const finishSignIn = async (
  start: Response,
  provider: "github" | "google" = "github",
): Promise<Response> => {
  // Better Auth answers a started social sign-in with `{url, redirect}`.
  const { url } = await start.clone().json<{ url: string }>();
  const state = new URL(url).searchParams.get("state") ?? "";

  return call(`/api/auth/callback/${provider}?code=code-1&state=${encodeURIComponent(state)}`, {
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

/** Who sets up the orgs here: an owner with the sensitive powers, as a platform admin is. */
const OWNER = { role: "owner", sensitive: true } as const;

/** Brings the registry's index of `org` up to date, as the app Worker's member routes do. */
export const syncIndex = async (org: OrgId): Promise<void> =>
  await Effect.runPromise(
    syncOrgIndex(org).pipe(Effect.provideService(AuthDirectory, stateAuthDirectory(env))),
  );

/** Makes `email` a member of `org` with `role`, as `POST /members` does (the member routes are the app Worker's). */
export const addMember = async (
  org: OrgId,
  email: string,
  role: "owner" | "admin" | "member",
): Promise<string> => {
  const added = await controlPlaneOf(env, org).addMember({ email, role }, OWNER, "test");

  if (!added.ok) throw new Error(added.message);
  await syncIndex(org);

  return added.value.id;
};

/** A new org `slug` owned by `owner`, as `POST /orgs` makes it; its id. */
export const orgOwnedBy = async (slug: string, owner: string): Promise<OrgId> => {
  const org = newOrgId();
  const created = await platformOf(env).createOrg({ slug, name: slug, id: org }, Date.now());

  if (!created.ok) throw new Error(created.message);
  await addMember(org, owner, "owner");

  return org;
};

/** The members of `org`: their ids, emails and roles. */
export const membersOf = async (org: OrgId) =>
  (await controlPlaneOf(env, org).listMembers()).map(({ id, email, role }) => ({
    id,
    email,
    role,
  }));

/** The slugs of the orgs the Platform registry lists `email` in. */
export const orgsOf = async (email: string): Promise<ReadonlyArray<string>> =>
  (await platformOf(env).orgsOfEmail(email)).map((org) => org.slug);
