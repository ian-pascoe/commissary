// Hosted sign-in (ADR 0026, src/hosted/routes.ts): Better Auth's GitHub flow through the Worker, Turnstile in front of
// it, only verified emails, secure session cookies, sign-out, and nothing else of Better Auth's API reachable.
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  call,
  clearPeople,
  cookiesOf,
  finishSignIn,
  GOOD_TURNSTILE,
  installFakes,
  ORIGIN,
  restoreFetch,
  signIn,
  startSignIn,
  upstreams,
} from "./support.ts";

beforeAll(installFakes);

afterAll(restoreFetch);

beforeEach(async () => {
  await clearPeople();
  upstreams.person = { email: "ada@example.com" };
  upstreams.turnstileDown = false;
  upstreams.siteverify = [];
  upstreams.unexpected = [];
});

const session = async (cookie: string) => {
  const response = await call("/api/auth/get-session", { headers: { cookie } });
  expect(response.status).toBe(200);

  // Better Auth answers `get-session` with the session and its user, or `null`.
  return await response.json<{ user: { email: string; emailVerified: boolean } } | null>();
};

describe("sign-in options", () => {
  it("lists the enabled providers and the Turnstile site key", async () => {
    const response = await call("/api/sign-in-options");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      providers: ["github", "google"],
      turnstile_site_key: env.TURNSTILE_SITE_KEY,
    });
  });
});

describe("sign-in with GitHub", () => {
  it("signs a person in with their verified email and a Secure, HttpOnly, SameSite=Lax session cookie", async () => {
    const start = await startSignIn();
    expect(start.status).toBe(200);
    expect(upstreams.siteverify).toEqual([
      { secret: env.TURNSTILE_SECRET_KEY, response: GOOD_TURNSTILE },
    ]);

    const callback = await finishSignIn(start);
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/");

    const cookie = callback.headers
      .getSetCookie()
      .find((value) => value.startsWith("__Secure-better-auth.session_token="));

    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/;\s*Secure/i);
    expect(cookie).toMatch(/;\s*HttpOnly/i);
    expect(cookie).toMatch(/;\s*SameSite=Lax/i);

    expect((await session(cookiesOf(callback)))?.user).toMatchObject({
      email: "ada@example.com",
      emailVerified: true,
    });
  });

  it("keeps neither the provider's tokens nor the browser's address or user agent", async () => {
    await signIn({ email: "ada@example.com" });

    const account = await env.USAGE.prepare(
      'SELECT "accessToken", "refreshToken", "idToken" FROM auth_account',
    ).first();

    expect(account).toEqual({ accessToken: null, refreshToken: null, idToken: null });

    const stored = await env.USAGE.prepare(
      'SELECT "ipAddress", "userAgent" FROM auth_session',
    ).first();

    expect(stored).toEqual({ ipAddress: null, userAgent: null });
  });

  it("refuses an email the provider has not verified", async () => {
    upstreams.person = { email: "eve@example.com", verified: false };
    const callback = await finishSignIn(await startSignIn());

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toContain("/sign-in?error=email_not_verified");
    expect(cookiesOf(callback)).not.toContain("session_token");

    const people = await env.USAGE.prepare("SELECT count(*) AS n FROM auth_user").first<{
      n: number;
    }>();

    expect(people?.n).toBe(0);
  });

  it("sign-out ends the session", async () => {
    const cookie = await signIn({ email: "ada@example.com" });
    expect(await session(cookie)).not.toBeNull();

    const out = await call("/api/auth/sign-out", {
      method: "POST",
      headers: {
        cookie,
        origin: ORIGIN,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      body: "{}",
    });

    expect(out.status).toBe(200);

    expect(await session(cookie)).toBeNull();
  });
});

describe("Turnstile", () => {
  it("blocks a sign-in (and so a sign-up) without a valid token", async () => {
    for (const token of [null, "", "forged"]) {
      const start = await startSignIn(token);

      expect(start.status).toBe(403);
      expect(await start.json()).toEqual({ error: "turnstile_failed" });
    }

    // A missing token never reaches siteverify.
    expect(upstreams.siteverify.map((body) => body["response"])).toEqual(["forged"]);
  });

  it("blocks a sign-in while siteverify is unreachable", async () => {
    upstreams.turnstileDown = true;
    const start = await startSignIn();

    expect(start.status).toBe(503);
  });
});

describe("cross-site requests", () => {
  it("refuses a sign-in or sign-out started by another site", async () => {
    for (const [path, headers] of [
      ["/api/auth/sign-in/social", { origin: "https://evil.test" }],
      ["/api/auth/sign-in/social", { "sec-fetch-site": "cross-site" }],
      ["/api/auth/sign-out", { origin: "https://evil.test" }],
    ] as const) {
      const response = await call(path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-captcha-response": GOOD_TURNSTILE,
          ...headers,
        },
        body: JSON.stringify({ provider: "github", callbackURL: "/" }),
      });

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Cross-site request rejected" });
    }

    expect(upstreams.siteverify).toEqual([]);
  });
});

describe("the rest of Better Auth's API", () => {
  it("answers 404 like an unknown path", async () => {
    for (const [method, path] of [
      ["POST", "/api/auth/sign-up/email"],
      ["POST", "/api/auth/sign-in/email"],
      ["GET", "/api/auth/list-sessions"],
      ["POST", "/api/auth/update-user"],
      ["POST", "/api/auth/link-social"],
      ["GET", "/api/auth/error"],
      ["GET", "/api/auth/callback/github/extra"],
    ] as const) {
      const response = await call(path, {
        method,
        headers: { origin: ORIGIN, "content-type": "application/json" },
        ...(method === "POST" ? { body: "{}" } : {}),
      });

      expect(response.status, `${method} ${path}`).toBe(404);
      expect(await response.text()).toBe("404 page not found");
    }
  });
});
