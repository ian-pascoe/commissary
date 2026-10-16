// Per-org single sign-on on Commissary Cloud (issue #76; src/sso/, src/management/sso-routes.ts, src/hosted/): an org
// owner proves an email domain with a DNS TXT record and sets one identity provider; people of that domain sign in
// through it (OIDC or SAML) and become members; GitHub and Google are refused for a domain that requires single
// sign-on. The DNS resolver and the identity providers are fakes behind the global `fetch`.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetStandingCaches } from "../../src/hosted/standing.ts";
import { DOH_URL } from "../../src/sso/dns.ts";
import {
  OIDC_CLIENT_ID,
  OIDC_CLIENT_SECRET,
  OIDC_ISSUER,
  oidcIssuer,
  oidcState,
  SAML_CERTIFICATE,
  SAML_ENTITY_ID,
  SAML_SSO_URL,
  samlAnswer,
} from "./identity-providers.ts";
import {
  call,
  clearPeople,
  cookiesOf,
  finishSignIn,
  GOOD_TURNSTILE,
  installFakes,
  ORIGIN,
  panelHeaders,
  restoreFetch,
  signIn,
  startSignIn,
  upstreams,
} from "./support.ts";

/** TXT records the fake resolver answers, by name. */
const txt = new Map<string, Array<string>>();

/** DNS over HTTPS: TXT records from {@link txt}; any other question (an address lookup) has no answer. */
const resolver = (request: Request): Response | undefined => {
  const url = new URL(request.url);

  if (`${url.origin}${url.pathname}` !== DOH_URL) return undefined;
  const name = url.searchParams.get("name") ?? "";

  if (url.searchParams.get("type") !== "TXT") return Response.json({ Status: 0, Answer: [] });

  return Response.json({
    Status: 0,
    Answer: (txt.get(name) ?? []).map((value) => ({ name, type: 16, data: `"${value}"` })),
  });
};

/** The person Google signs in next. */
let googleEmail = "";

const base64url = (json: string) =>
  btoa(json).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

/** Google's token endpoint: an ID token for {@link googleEmail} (Better Auth reads it without checking a signature). */
const google = (request: Request): Response | undefined => {
  if (request.url !== "https://oauth2.googleapis.com/token") return undefined;

  const claims = {
    iss: "https://accounts.google.com",
    sub: `google-${googleEmail}`,
    email: googleEmail,
    email_verified: true,
    name: googleEmail,
  };

  return Response.json({
    access_token: "ya29.test",
    token_type: "Bearer",
    expires_in: 3600,
    id_token: `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify(claims))}.signature`,
  });
};

beforeAll(async () => {
  await installFakes();
  const fakes = globalThis.fetch;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);

    return (
      resolver(request) ?? google(request) ?? (await oidcIssuer(request)) ?? (await fakes(request))
    );
  };
});

afterAll(restoreFetch);

beforeEach(async () => {
  await clearPeople();
  resetStandingCaches();
  upstreams.unexpected = [];
  oidcState.tokenRequests = [];
});

/** A JSON management request of the signed-in `cookie`. */
const json = (
  cookie: string,
  method: string,
  body?: Readonly<Record<string, string | boolean>>,
) => ({
  method,
  headers: panelHeaders(cookie, { "content-type": "application/json" }),
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const sso = (org: string, path = "") => `/v9/management/orgs/${org}/sso${path}`;

interface DomainView {
  readonly domain: string;
  readonly verified: boolean;
  readonly require_sso: boolean;
  readonly record: { readonly name: string; readonly value: string };
}

interface Settings {
  readonly provider: Record<string, unknown> | null;
  readonly domains: ReadonlyArray<DomainView>;
  readonly service_provider: {
    readonly oidc_redirect_uri: string;
    readonly saml_acs_url: string;
    readonly saml_entity_id: string;
    readonly saml_metadata_url: string;
  };
}

/** An org `slug` owned by a fresh owner (signed in with GitHub, at another domain); the owner's cookie. */
const orgOwnedBy = async (slug: string): Promise<string> => {
  const owner = await signIn({ email: `owner-${slug}@example.com` });

  expect(
    (await call("/v9/management/orgs", json(owner, "POST", { slug, name: slug }))).status,
  ).toBe(201);

  return owner;
};

/** Adds `domain` to the org, publishes its TXT record and verifies it; the verify response. */
const proveDomain = async (owner: string, org: string, domain: string): Promise<Response> => {
  const added = await call(sso(org, "/domains"), json(owner, "POST", { domain }));
  expect(added.status).toBe(201);
  const { record } = await added.json<DomainView>();

  txt.set(record.name, [...(txt.get(record.name) ?? []), record.value]);

  return await call(sso(org, `/domains/${domain}/verify`), json(owner, "POST"));
};

const setOidc = (owner: string, org: string) =>
  call(
    sso(org, "/provider"),
    json(owner, "PUT", {
      kind: "oidc",
      issuer: OIDC_ISSUER,
      client_id: OIDC_CLIENT_ID,
      client_secret: OIDC_CLIENT_SECRET,
    }),
  );

/** An org with `domain` verified and the fake OIDC issuer as its provider; the owner's cookie. */
const oidcOrg = async (slug: string, domain: string): Promise<string> => {
  const owner = await orgOwnedBy(slug);

  expect((await proveDomain(owner, slug, domain)).status).toBe(200);
  expect((await setOidc(owner, slug)).status).toBe(200);

  return owner;
};

/** Starts a sign-in with a work email the way the sign-in page does. */
const startSso = (email: string) =>
  call("/api/auth/sign-in/sso", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "x-captcha-response": GOOD_TURNSTILE,
    },
    body: JSON.stringify({ email }),
  });

/** Signs `email` in through Google; the callback's response. */
const googleSignIn = async (email: string): Promise<Response> => {
  const start = await call("/api/auth/sign-in/social", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "x-captcha-response": GOOD_TURNSTILE,
    },
    body: JSON.stringify({ provider: "google", callbackURL: "/" }),
  });

  expect(start.status).toBe(200);
  const { url } = await start.clone().json<{ url: string }>();
  const state = new URL(url).searchParams.get("state") ?? "";

  googleEmail = email;

  return await call(`/api/auth/callback/google?code=code-1&state=${encodeURIComponent(state)}`, {
    headers: { cookie: cookiesOf(start), "sec-fetch-site": "cross-site" },
  });
};

/** Signs `email` in through the fake OIDC issuer; the callback's response. */
const oidcSignIn = async (email: string): Promise<Response> => {
  const start = await startSso(email);
  expect(start.status).toBe(200);
  const { url } = await start.json<{ url: string }>();
  const authorize = new URL(url);

  expect(`${authorize.origin}${authorize.pathname}`).toBe(`${OIDC_ISSUER}/authorize`);
  expect(authorize.searchParams.get("login_hint")).toBe(email);
  oidcState.email = email;
  const callback = new URL(authorize.searchParams.get("redirect_uri") ?? "");

  return await call(
    `${callback.pathname}?code=code-1&state=${encodeURIComponent(authorize.searchParams.get("state") ?? "")}`,
    { headers: { cookie: cookiesOf(start), "sec-fetch-site": "cross-site" } },
  );
};

const signedIn = async (cookie: string) =>
  await call("/v9/management/me", { headers: panelHeaders(cookie) });

const members = async (owner: string, org: string) => {
  const response = await call(`/v9/management/orgs/${org}/members`, {
    headers: panelHeaders(owner),
  });

  expect(response.status).toBe(200);

  return (await response.json<{ members: Array<{ id: string; email: string; role: string }> }>())
    .members;
};

/** Where a refused sign-in sends the browser: the sign-in page with the reason. */
const refusal = (response: Response): string | null => {
  expect(response.status).toBe(302);
  expect(cookiesOf(response)).not.toContain("session_token");

  return new URL(response.headers.get("location") ?? "", ORIGIN).searchParams.get("error");
};

describe("setting up single sign-on", () => {
  it("proves a domain with its TXT record and keeps the client secret out of the settings", async () => {
    const owner = await orgOwnedBy("setup");

    const added = await call(
      sso("setup", "/domains"),
      json(owner, "POST", { domain: "Setup.COM" }),
    );

    expect(added.status).toBe(201);
    const domain = await added.json<DomainView>();

    expect(domain).toMatchObject({ domain: "setup.com", verified: false, require_sso: false });
    expect(domain.record.name).toBe("_commissary-challenge.setup.com");

    // No record yet.
    const early = await call(sso("setup", "/domains/setup.com/verify"), json(owner, "POST"));
    expect(early.status).toBe(422);
    expect(await early.json()).toMatchObject({ error: "record_not_found" });

    txt.set(domain.record.name, ["something else", domain.record.value]);
    const verified = await call(sso("setup", "/domains/setup.com/verify"), json(owner, "POST"));
    expect(verified.status).toBe(200);
    expect(await verified.json()).toMatchObject({ domain: "setup.com", verified: true });

    // Requiring single sign-on needs a provider first.
    const earlyRequire = await call(
      sso("setup", "/domains/setup.com"),
      json(owner, "PATCH", { require_sso: true }),
    );

    expect(earlyRequire.status).toBe(404);
    expect(await earlyRequire.json()).toMatchObject({ error: "provider_missing" });

    expect((await setOidc(owner, "setup")).status).toBe(200);
    const settings = await call(sso("setup"), { headers: panelHeaders(owner) });
    const body = await settings.text();

    expect(body).not.toContain(OIDC_CLIENT_SECRET);
    // SAFETY: a 200 answers `SsoSettings` (@commissary/contract/sso).
    expect(JSON.parse(body) as Settings).toMatchObject({
      provider: {
        kind: "oidc",
        issuer: OIDC_ISSUER,
        client_id: OIDC_CLIENT_ID,
        token_endpoint: `${OIDC_ISSUER}/token`,
      },
      domains: [{ domain: "setup.com", verified: true }],
    });

    // The provider answers a test.
    const test = await call(sso("setup", "/provider/test"), json(owner, "POST"));
    expect(test.status).toBe(200);
  });

  it("does not let a management key change it, even an owner's", async () => {
    const owner = await orgOwnedBy("keyed-sso");

    const issued = await call(
      "/v9/management/orgs/keyed-sso/management-keys",
      json(owner, "POST", { name: "ci", role: "owner" }),
    );

    expect(issued.status).toBe(201);
    const { key } = await issued.json<{ key: string }>();
    const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };

    expect((await call(sso("keyed-sso"), { headers })).status).toBe(200);

    const refused = await call(sso("keyed-sso", "/domains"), {
      method: "POST",
      headers,
      body: JSON.stringify({ domain: "keyed.com" }),
    });

    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: "management_key_forbidden" });
  });

  it("does not let a second org claim a domain another org verified", async () => {
    const first = await orgOwnedBy("first");
    expect((await proveDomain(first, "first", "shared.com")).status).toBe(200);

    const second = await orgOwnedBy("second");
    const claimed = await proveDomain(second, "second", "shared.com");

    expect(claimed.status).toBe(409);
    expect(await claimed.json()).toMatchObject({ error: "domain_taken" });

    // Once the first org removes it, the second can verify it.
    expect((await call(sso("first", "/domains/shared.com"), json(first, "DELETE"))).status).toBe(
      200,
    );
    expect(
      (await call(sso("second", "/domains/shared.com/verify"), json(second, "POST"))).status,
    ).toBe(200);
  });
});

describe("signing in with an org's identity provider", () => {
  it("signs a person in through OIDC and makes them a member of the org", async () => {
    const owner = await oidcOrg("oidc-org", "oidc-corp.com");
    const callback = await oidcSignIn("olga@oidc-corp.com");

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/");
    const cookie = cookiesOf(callback);

    expect(cookie).toContain("session_token");
    const me = await signedIn(cookie);
    expect(me.status).toBe(200);
    expect((await me.json<{ orgs: Array<{ slug: string }> }>()).orgs).toEqual([
      expect.objectContaining({ slug: "oidc-org" }),
    ]);
    expect(await members(owner, "oidc-org")).toContainEqual(
      expect.objectContaining({ email: "olga@oidc-corp.com", role: "member" }),
    );

    // Commissary authenticated as the org's client, with PKCE.
    expect(oidcState.tokenRequests[0]?.get("code_verifier")).toBeTruthy();
  });

  it("signs a person in through SAML and makes them a member of the org", async () => {
    const owner = await orgOwnedBy("saml-org");
    expect((await proveDomain(owner, "saml-org", "saml-corp.com")).status).toBe(200);

    const provider = await call(
      sso("saml-org", "/provider"),
      json(owner, "PUT", {
        kind: "saml",
        entry_point: SAML_SSO_URL,
        idp_entity_id: SAML_ENTITY_ID,
        certificate: SAML_CERTIFICATE,
      }),
    );

    expect(provider.status).toBe(200);

    const settings = await (
      await call(sso("saml-org"), { headers: panelHeaders(owner) })
    ).json<Settings>();

    const start = await startSso("sam@saml-corp.com");
    expect(start.status).toBe(200);
    const { url } = await start.json<{ url: string }>();
    expect(url.startsWith(`${SAML_SSO_URL}?`)).toBe(true);

    const answer = await samlAnswer(
      url,
      {
        entityId: settings.service_provider.saml_entity_id,
        acsUrl: settings.service_provider.saml_acs_url,
      },
      "sam@saml-corp.com",
    );

    // The identity provider's page posts the answer from its own site.
    const acs = await call(new URL(settings.service_provider.saml_acs_url).pathname, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: new URL(SAML_SSO_URL).origin,
        "sec-fetch-site": "cross-site",
      },
      body: new URLSearchParams(answer).toString(),
    });

    expect(acs.status).toBe(302);
    const cookie = cookiesOf(acs);
    expect(cookie).toContain("session_token");
    expect((await signedIn(cookie)).status).toBe(200);
    expect(await members(owner, "saml-org")).toContainEqual(
      expect.objectContaining({ email: "sam@saml-corp.com", role: "member" }),
    );

    // The same answer cannot be posted twice.
    const replay = await call(new URL(settings.service_provider.saml_acs_url).pathname, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: new URL(SAML_SSO_URL).origin,
        "sec-fetch-site": "cross-site",
      },
      body: new URLSearchParams(answer).toString(),
    });

    expect(refusal(replay)).toBe("invalid_saml_response");
  });

  it("keeps the role of someone who already was a member", async () => {
    const owner = await oidcOrg("member-org", "member-corp.com");

    expect(
      (
        await call(
          "/v9/management/orgs/member-org/members",
          json(owner, "POST", { email: "ada@member-corp.com", role: "admin" }),
        )
      ).status,
    ).toBe(201);

    expect((await oidcSignIn("ada@member-corp.com")).headers.get("location")).toBe("/");
    expect(await members(owner, "member-org")).toContainEqual(
      expect.objectContaining({ email: "ada@member-corp.com", role: "admin" }),
    );
  });

  it("takes a work email only with a solved bot check", async () => {
    await oidcOrg("bot-org", "bot-corp.com");

    const start = await call("/api/auth/sign-in/sso", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ email: "bea@bot-corp.com" }),
    });

    expect(start.status).toBe(403);
  });

  it("does not redirect for a domain no org verified", async () => {
    const owner = await orgOwnedBy("pending-org");
    expect(
      (await call(sso("pending-org", "/domains"), json(owner, "POST", { domain: "pending.com" })))
        .status,
    ).toBe(201);
    expect((await setOidc(owner, "pending-org")).status).toBe(200);

    for (const email of ["pat@pending.com", "nobody@unknown-corp.com", "not an email"]) {
      const start = await startSso(email);

      expect(start.status).toBe(404);
      expect(await start.json()).toMatchObject({ error: "sso_not_found" });
    }
  });

  it("does not let an org's provider sign in an email of another domain", async () => {
    await oidcOrg("narrow-org", "narrow.com");
    const callback = await oidcSignIn("olga@narrow.com");
    expect(callback.status).toBe(302);

    // The issuer answers with someone of a domain the org has not verified.
    const start = await startSso("eve@narrow.com");
    const { url } = await start.json<{ url: string }>();
    const authorize = new URL(url);
    oidcState.email = "eve@elsewhere.com";
    const callbackUrl = new URL(authorize.searchParams.get("redirect_uri") ?? "");

    const response = await call(
      `${callbackUrl.pathname}?code=code-2&state=${encodeURIComponent(authorize.searchParams.get("state") ?? "")}`,
      { headers: { cookie: cookiesOf(start), "sec-fetch-site": "cross-site" } },
    );

    expect(refusal(response)).toBe("sso_domain_unverified");
  });

  it("does not add back someone an org admin removed, until they are added again", async () => {
    const owner = await oidcOrg("removal-org", "removal.com");
    expect((await oidcSignIn("rita@removal.com")).status).toBe(302);

    const rita = (await members(owner, "removal-org")).find(
      (member) => member.email === "rita@removal.com",
    );

    expect(
      (await call(`/v9/management/orgs/removal-org/members/${rita?.id}`, json(owner, "DELETE")))
        .status,
    ).toBe(200);

    resetStandingCaches();
    expect(refusal(await oidcSignIn("rita@removal.com"))).toBe("sso_removed");
    expect((await members(owner, "removal-org")).map((member) => member.email)).not.toContain(
      "rita@removal.com",
    );

    expect(
      (
        await call(
          "/v9/management/orgs/removal-org/members",
          json(owner, "POST", { email: "rita@removal.com", role: "member" }),
        )
      ).status,
    ).toBe(201);

    const again = await oidcSignIn("rita@removal.com");
    expect(again.status).toBe(302);
    expect(cookiesOf(again)).toContain("session_token");
  });
});

describe("requiring single sign-on", () => {
  it("refuses GitHub for the domain and ends the sessions its people had", async () => {
    const owner = await oidcOrg("strict-org", "strict.com");

    // Before: GitHub works for the domain.
    const github = await signIn({ email: "gina@strict.com" });
    expect((await signedIn(github)).status).toBe(200);
    const other = await signIn({ email: "gina@example.com" });

    const required = await call(
      sso("strict-org", "/domains/strict.com"),
      json(owner, "PATCH", { require_sso: true }),
    );

    expect(required.status).toBe(200);
    expect(await required.json()).toMatchObject({ require_sso: true });

    // Her GitHub session is gone; someone of another domain keeps theirs.
    resetStandingCaches();
    expect((await signedIn(github)).status).toBe(401);
    expect((await signedIn(other)).status).toBe(200);

    // GitHub and Google are refused for the domain now; the identity provider still signs her in.
    upstreams.person = { email: "gina@strict.com" };
    expect(await signIn({ email: "gina@strict.com" })).toBe("");
    expect(await signIn({ email: "gina@example.com" })).toContain("session_token");
    expect(refusal(await googleSignIn("gina@strict.com"))).toBe("sso_required");
    expect(cookiesOf(await googleSignIn("gina@example.com"))).toContain("session_token");
    expect((await oidcSignIn("gina@strict.com")).headers.get("location")).toBe("/");

    // The provider cannot be removed while a domain requires it.
    const removal = await call(sso("strict-org", "/provider"), json(owner, "DELETE"));
    expect(removal.status).toBe(409);
    expect(await removal.json()).toMatchObject({ error: "sso_required" });
  });

  it("says why GitHub was refused", async () => {
    const owner = await oidcOrg("why-org", "why.com");
    expect(
      (await call(sso("why-org", "/domains/why.com"), json(owner, "PATCH", { require_sso: true })))
        .status,
    ).toBe(200);

    upstreams.person = { email: "walt@why.com" };
    const callback = await finishSignIn(await startSignIn());

    expect(refusal(callback)).toBe("sso_required");
  });
});
