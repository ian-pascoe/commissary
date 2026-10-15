// The gate of Commissary Cloud (ADR 0026, src/hosted/gate.ts): session cookies for the panel and the management API,
// API keys for the client API, no Access credentials anywhere, sign-up with a Personal org, the owned-org limit, and
// suspension of people and orgs by platform admins.
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetStandingCaches } from "../../src/hosted/standing.ts";
import {
  call,
  clearPeople,
  installFakes,
  panelHeaders,
  restoreFetch,
  signIn,
  upstreams,
} from "./support.ts";

beforeAll(installFakes);

afterAll(restoreFetch);

beforeEach(async () => {
  await clearPeople();
  resetStandingCaches();
  upstreams.unexpected = [];
});

const ROOT = "root@example.com";

interface Me {
  readonly platform_admin: boolean;
  readonly role: string | null;
  readonly orgs: ReadonlyArray<{ readonly slug: string; readonly name: string }>;
  readonly hosted?: boolean;
  readonly org_limit?: number;
  readonly owned_orgs?: number;
}

/** A JSON body of a management request. */
type Body = Readonly<Record<string, string | number | boolean | null>>;

const json = (cookie: string, method: string, body: Body) => ({
  method,
  headers: panelHeaders(cookie, { "content-type": "application/json" }),
  body: JSON.stringify(body),
});

const me = async (cookie: string): Promise<Me> => {
  const response = await call("/v9/management/me", { headers: panelHeaders(cookie) });
  expect(response.status).toBe(200);

  return await response.json<Me>();
};

const createOrg = (cookie: string, slug: string) =>
  call("/v9/management/orgs", json(cookie, "POST", { slug, name: slug }));

/** A new API key of the signed-in person in `org`. */
const apiKey = async (cookie: string, org: string): Promise<string> => {
  const response = await call(
    `/v9/management/orgs/${org}/api-keys`,
    json(cookie, "POST", { name: "laptop" }),
  );

  expect(response.status).toBe(201);

  return (await response.json<{ key: string }>()).key;
};

const models = (key: string) => call("/v1/models", { headers: { authorization: `Bearer ${key}` } });

describe("signing up", () => {
  it("gives a person signing in for the first time a Personal org they own", async () => {
    const cookie = await signIn({ email: "ada@example.com" });
    const first = await me(cookie);

    expect(first).toMatchObject({
      platform_admin: false,
      hosted: true,
      org_limit: 3,
      owned_orgs: 1,
    });
    expect(first.orgs).toHaveLength(1);
    expect(first.orgs[0]?.name).toBe("Personal");
    expect(first.orgs[0]?.slug).toMatch(/^personal-[0-9a-f]{10}$/);

    const members = await call(`/v9/management/orgs/${first.orgs[0]?.slug}/members`, {
      headers: panelHeaders(cookie),
    });

    expect(members.status).toBe(200);
    expect(await members.json()).toMatchObject({
      members: [{ email: "ada@example.com", role: "owner" }],
    });

    // Signing in again creates nothing more.
    resetStandingCaches();
    const again = await me(await signIn({ email: "ada@example.com" }));
    expect(again.orgs).toEqual(first.orgs);
  });

  it("gives an invited person no Personal org", async () => {
    const owner = await signIn({ email: "owner@example.com" });
    const created = await createOrg(owner, "acme");
    expect(created.status).toBe(201);

    const invited = await call(
      "/v9/management/orgs/acme/members",
      json(owner, "POST", { email: "bob@example.com", role: "member" }),
    );

    expect(invited.status).toBe(201);

    const bob = await me(await signIn({ email: "bob@example.com" }));
    expect(bob.orgs).toEqual([{ slug: "acme", name: "acme" }]);
    expect(bob.owned_orgs).toBe(0);
  });

  it("does not let everyone signed in join global, even with its auto-join on", async () => {
    const root = await signIn({ email: ROOT });

    // A stage that was self-hosted keeps `global`'s auto-join on.
    expect(
      (
        await call(
          "/v9/management/orgs/default/membership",
          json(root, "PATCH", { auto_join: true }),
        )
      ).status,
    ).toBe(200);

    const cookie = await signIn({ email: "eve@example.com" });

    const response = await call("/v9/management/orgs/default/members", {
      headers: panelHeaders(cookie),
    });

    expect(response.status).toBe(403);
    expect((await me(cookie)).orgs.map((org) => org.slug)).not.toContain("default");
    await call("/v9/management/orgs/default/membership", json(root, "PATCH", { auto_join: false }));
  });
});

describe("authentication", () => {
  it("answers a management request without a session with 401 and sends a browser to the sign-in page", async () => {
    const api = await call("/v9/management/me", { headers: panelHeaders("") });
    expect(api.status).toBe(401);
    expect(await api.json()).toMatchObject({ error: "Not signed in" });

    const page = await call("/o/acme/usage?range=7d");
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe(
      `/sign-in?next=${encodeURIComponent("/o/acme/usage?range=7d")}`,
    );

    const home = await call("/");
    expect(home.status).toBe(302);
    expect(home.headers.get("location")).toBe("/sign-in");
  });

  it("serves the sign-in page and the panel's bundle files to anyone", async () => {
    // Answered by the assets binding (404 while the panel is not built), never refused or redirected.
    for (const path of ["/sign-in", "/assets/missing.js"])
      expect([200, 404]).toContain((await call(path)).status);

    // What tools/check-hosted-deploy.sh probes after a deploy.
    expect((await call("/healthz")).status).toBe(200);
  });

  it("accepts no Access JWT and no Access service token", async () => {
    for (const headers of [
      { "cf-access-jwt-assertion": "eyJhbGciOiJSUzI1NiJ9.e30.c2ln" },
      { cookie: "CF_Authorization=eyJhbGciOiJSUzI1NiJ9.e30.c2ln" },
      { "cf-access-client-id": "admin-token.access", "cf-access-client-secret": "secret" },
    ]) {
      const response = await call("/v9/management/me", {
        headers: { ...headers, origin: "https://proxy.test", "sec-fetch-site": "same-origin" },
      });

      expect(response.status).toBe(401);
    }
  });

  it("takes only API keys on the client API", async () => {
    expect((await call("/v1/models")).status).toBe(401);

    const cookie = await signIn({ email: "ada@example.com" });
    const proxied = await call("/v1/models", { headers: { cookie } });
    expect(proxied.status).toBe(401);

    const org = (await me(cookie)).orgs[0]?.slug ?? "";
    expect((await models(await apiKey(cookie, org))).status).toBe(200);
  });

  it("refuses cross-site management requests and form posts", async () => {
    const cookie = await signIn({ email: "ada@example.com" });

    const crossSite = await call("/v9/management/orgs", {
      method: "POST",
      headers: { cookie, "sec-fetch-site": "cross-site", "content-type": "application/json" },
      body: JSON.stringify({ slug: "x", name: "x" }),
    });

    expect(crossSite.status).toBe(403);

    const form = await call("/v9/management/orgs", {
      method: "POST",
      headers: panelHeaders(cookie, { "content-type": "text/plain" }),
      body: JSON.stringify({ slug: "x", name: "x" }),
    });

    expect(form.status).toBe(415);
  });

  it("makes platform admins of the people in PLATFORM_ADMIN_EMAILS only", async () => {
    expect(await me(await signIn({ email: ROOT }))).toMatchObject({ platform_admin: true });
    expect(await me(await signIn({ email: "ada@example.com" }))).toMatchObject({
      platform_admin: false,
    });
  });
});

describe("the owned-org limit", () => {
  it("lets a person create orgs up to the limit, which a platform admin raises", async () => {
    const cookie = await signIn({ email: "ada@example.com" });

    expect((await createOrg(cookie, "ada-two")).status).toBe(201);
    expect((await createOrg(cookie, "ada-three")).status).toBe(201);

    const refused = await createOrg(cookie, "ada-four");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "org_limit_reached" });

    const root = await signIn({ email: ROOT });

    const forbidden = await call(
      "/v9/management/people/ada@example.com",
      json(cookie, "PATCH", { org_limit: 10 }),
    );

    expect(forbidden.status).toBe(403);

    const raised = await call(
      "/v9/management/people/ada@example.com",
      json(root, "PATCH", { org_limit: 4 }),
    );

    expect(raised.status).toBe(200);
    expect(await raised.json()).toMatchObject({
      email: "ada@example.com",
      org_limit: 4,
      org_limit_set: true,
      owned_orgs: 3,
      suspended: false,
    });

    expect((await createOrg(cookie, "ada-four")).status).toBe(201);
    expect(await me(cookie)).toMatchObject({ org_limit: 4, owned_orgs: 4 });
  });

  it("leaves platform admins without a limit", async () => {
    const root = await signIn({ email: ROOT });

    for (const slug of ["r1", "r2", "r3", "r4"])
      expect((await createOrg(root, slug)).status).toBe(201);
  });

  it("checks the limit and the email of a people request", async () => {
    const root = await signIn({ email: ROOT });

    const bad = await call(
      "/v9/management/people/ada@example.com",
      json(root, "PATCH", { org_limit: -1 }),
    );

    expect(bad.status).toBe(422);
    expect(
      (await call("/v9/management/people/nobody", { headers: panelHeaders(root) })).status,
    ).toBe(422);
  });
});

describe("suspension", () => {
  it("signs a suspended person out and refuses their sessions and API keys until it is lifted", async () => {
    const cookie = await signIn({ email: "mallory@example.com" });
    const org = (await me(cookie)).orgs[0]?.slug ?? "";
    const key = await apiKey(cookie, org);
    const root = await signIn({ email: ROOT });

    const suspended = await call(
      "/v9/management/people/mallory@example.com",
      json(root, "PATCH", { suspended: true }),
    );

    expect(suspended.status).toBe(200);
    expect(await suspended.json()).toMatchObject({ suspended: true });

    expect((await call("/v9/management/me", { headers: panelHeaders(cookie) })).status).toBe(401);
    expect((await models(key)).status).toBe(403);

    // A new sign-in is refused too.
    upstreams.person = { email: "mallory@example.com" };
    expect(await signIn({ email: "mallory@example.com" }).catch(() => "")).toBe("");

    const lifted = await call(
      "/v9/management/people/mallory@example.com",
      json(root, "PATCH", { suspended: false }),
    );

    expect(lifted.status).toBe(200);
    expect((await models(key)).status).toBe(200);
    expect((await me(await signIn({ email: "mallory@example.com" }))).orgs).toHaveLength(1);
  });

  it("refuses everyone in a suspended org, signs its members out, and lets platform admins unsuspend it", async () => {
    const owner = await signIn({ email: "owner@example.com" });
    expect((await createOrg(owner, "shady")).status).toBe(201);
    const key = await apiKey(owner, "shady");
    const root = await signIn({ email: ROOT });

    const suspended = await call(
      "/v9/management/orgs/shady",
      json(root, "PATCH", { suspended: true }),
    );

    expect(suspended.status).toBe(200);
    expect(await suspended.json()).toMatchObject({ slug: "shady", suspended: true });

    expect((await call("/v9/management/me", { headers: panelHeaders(owner) })).status).toBe(401);
    expect((await models(key)).status).toBe(403);

    const again = await signIn({ email: "owner@example.com" });

    const members = await call("/v9/management/orgs/shady/members", {
      headers: panelHeaders(again),
    });

    expect(members.status).toBe(403);
    expect(await members.json()).toMatchObject({ error: "Suspended" });

    // The platform admin still reaches it.
    expect(
      (await call("/v9/management/orgs/shady/members", { headers: panelHeaders(root) })).status,
    ).toBe(200);

    const lifted = await call(
      "/v9/management/orgs/shady",
      json(root, "PATCH", { suspended: false }),
    );

    expect(lifted.status).toBe(200);
    expect(await lifted.json()).not.toHaveProperty("suspended");
    expect((await models(key)).status).toBe(200);
  });

  it("is for platform admins only", async () => {
    const owner = await signIn({ email: "carol@example.com" });
    expect((await createOrg(owner, "mine")).status).toBe(201);

    const response = await call(
      "/v9/management/orgs/mine",
      json(owner, "PATCH", { suspended: true }),
    );

    expect(response.status).toBe(403);
  });
});

describe("management keys and downloads", () => {
  it("takes management keys on the management API, refuses them while their org is suspended, and never takes an API key there", async () => {
    const owner = await signIn({ email: "dora@example.com" });

    expect((await createOrg(owner, "keyed")).status).toBe(201);

    const issued = await call(
      "/v9/management/orgs/keyed/management-keys",
      json(owner, "POST", { name: "ci", role: "admin" }),
    );

    expect(issued.status).toBe(201);
    const { key } = await issued.json<{ key: string }>();

    const members = () =>
      call("/v9/management/orgs/keyed/members", { headers: { authorization: `Bearer ${key}` } });

    expect((await members()).status).toBe(200);

    const apiKeyThere = await call("/v9/management/orgs/keyed/members", {
      headers: { authorization: `Bearer ${await apiKey(owner, "keyed")}` },
    });

    expect(apiKeyThere.status).toBe(401);

    const root = await signIn({ email: ROOT });

    expect(
      (await call("/v9/management/orgs/keyed", json(root, "PATCH", { suspended: true }))).status,
    ).toBe(200);
    expect((await members()).status).toBe(403);
    expect(
      (await call("/v9/management/orgs/keyed", json(root, "PATCH", { suspended: false }))).status,
    ).toBe(200);
    expect((await members()).status).toBe(200);
  });

  it("refuses a management key of a suspended person", async () => {
    const owner = await signIn({ email: "erin@example.com" });
    const org = (await me(owner)).orgs[0]?.slug ?? "";

    const issued = await call(
      `/v9/management/orgs/${org}/management-keys`,
      json(owner, "POST", { name: "ci", role: "admin" }),
    );

    const { key } = await issued.json<{ key: string }>();
    const root = await signIn({ email: ROOT });

    await call("/v9/management/people/erin@example.com", json(root, "PATCH", { suspended: true }));

    const refused = await call(`/v9/management/orgs/${org}/members`, {
      headers: { authorization: `Bearer ${key}` },
    });

    expect(refused.status).toBe(403);
    await call("/v9/management/people/erin@example.com", json(root, "PATCH", { suspended: false }));
  });

  it("lets only platform admins download stored credentials", async () => {
    const owner = await signIn({ email: "fay@example.com" });

    expect((await createOrg(owner, "files")).status).toBe(201);

    const uploaded = await call(
      "/v9/management/orgs/files/credentials?name=claude-fay.json",
      json(owner, "POST", {
        type: "claude",
        access_token: "sk-ant-oat-test",
        email: "fay@example.com",
      }),
    );

    expect(uploaded.status).toBe(200);
    const path = "/v9/management/orgs/files/credentials/download?name=claude-fay.json";
    const refused = await call(path, { headers: panelHeaders(owner) });

    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: "download_requires_platform_admin" });
    expect(
      (await call(path, { headers: panelHeaders(await signIn({ email: ROOT })) })).status,
    ).toBe(200);
  });
});

describe("deleting an account", () => {
  const authRows = async (email: string) => {
    const count = async (sql: string) =>
      (await env.USAGE.prepare(sql).bind(email).first<{ n: number }>())?.n;

    const ofUser = `"userId" IN (SELECT id FROM auth_user WHERE email = ?)`;

    return {
      users: await count(`SELECT count(*) AS n FROM auth_user WHERE email = ?`),
      sessions: await count(`SELECT count(*) AS n FROM auth_session WHERE ${ofUser}`),
      accounts: await count(`SELECT count(*) AS n FROM auth_account WHERE ${ofUser}`),
    };
  };

  it("deletes the sign-in account with its sessions, and a later sign-in is a new sign-up", async () => {
    const cookie = await signIn({ email: "gus@example.com" });
    const personal = (await me(cookie)).orgs[0]?.slug;

    expect(await authRows("gus@example.com")).toEqual({ users: 1, sessions: 1, accounts: 1 });

    const deleted = await call(
      "/v9/management/me",
      json(cookie, "DELETE", { email: "gus@example.com" }),
    );

    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({
      deleted: true,
      orgs_left: [],
      orgs_deleted: [personal],
    });
    expect(await authRows("gus@example.com")).toEqual({ users: 0, sessions: 0, accounts: 0 });
    expect((await call("/v9/management/me", { headers: panelHeaders(cookie) })).status).toBe(401);

    const again = await me(await signIn({ email: "gus@example.com" }));
    expect(again.owned_orgs).toBe(1);
    expect(again.orgs).toHaveLength(1);
    expect(again.orgs[0]?.slug).not.toBe(personal);
  });
});
