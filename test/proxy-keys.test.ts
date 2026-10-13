// Proxy keys (ADR 0022, issue #67): the key text, the management routes that issue and revoke keys, and the gate on
// the proxy routes: each header form a client sends keys in, the refusals (all `Invalid API key`), that a key only ever
// reaches its own org's ControlPlane, revocation within the cache window, and the Access sign-ins a proxy route still
// takes while the org's `access_clients` setting is on. Through the router with the real ControlPlanes and a Platform
// registry of its own; the cache window through `authenticateRequest` with `TestClock`.
import { env } from "cloudflare:workers";
import { assert, it as effectIt } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { afterAll, describe, expect, it } from "vitest";
import { authenticateRequest } from "../src/access/authenticate.ts";
import type { AccessJwks } from "../src/access/jwks.ts";
import { AccessPrincipal } from "../src/access/principal.ts";
import { VERIFIED_KEY_TTL_MS } from "../src/access/proxy-key.ts";
import { requestContext, type WorkerEnv } from "../src/platform/env.ts";
import { controlPlaneOf, type CurrentOrg, GLOBAL_ORG, OrgId } from "../src/platform/org.ts";
import { mintProxyKey, parseProxyKey } from "../src/proxy-keys/key.ts";
import { MAX_KEYS_PER_MEMBER } from "../src/proxy-keys/store.ts";
import { fakeJwksLayer, makeFakeJwks, makeKey, signToken, userClaims } from "./support/access.ts";
import {
  ADMIN,
  isolatedPlatform,
  jsonInit,
  key as managementKey,
  makeHarness,
  serviceToken,
  token,
} from "./support/management.ts";

/** What the stand-in proxy route saw of its caller. */
interface Seen {
  readonly principal_id: string;
  readonly org: string;
  readonly member_id?: string;
  readonly role?: string;
  readonly caller_scope: string;
}

const whoami = Effect.gen(function* () {
  const identity = yield* AccessPrincipal;

  return HttpServerResponse.text(
    JSON.stringify({
      principal_id: identity.principalId,
      org: identity.org,
      member_id: identity.memberId,
      role: identity.role,
      caller_scope: identity.callerScope,
    }),
    { contentType: "application/json" },
  );
});

const ProxyRoutes = Layer.mergeAll(
  HttpRouter.add("GET", "/v1/models", whoami),
  HttpRouter.add("POST", "/v1/messages", whoami),
  HttpRouter.add("GET", "/v1beta/models", whoami),
  HttpRouter.add("POST", "/openai/v1/chat/completions", whoami),
  HttpRouter.add("POST", "/backend-api/codex/responses", whoami),
  HttpRouter.add("POST", "/responses", whoami),
);

const registry = isolatedPlatform();

const accessKey = await makeKey("proxy-keys-kid");

const harness = makeHarness(undefined, registry.bindings, GLOBAL_ORG, ProxyRoutes);

afterAll(harness.dispose);

interface Auth {
  readonly auth: string;
}

interface KeyBody {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly member_id: string;
  readonly member_email?: string;
  readonly mine: boolean;
  readonly last_used_at?: string;
  readonly revoked_at?: string;
  readonly key?: string;
}

const as = async (email: string): Promise<Auth> => ({ auth: await token(email) });

const api = (slug: string, path: string) => `/v8/management/orgs/${slug}${path}`;

const send = async (
  slug: string,
  path: string,
  who: Auth,
  method = "GET",
  body?: Parameters<typeof jsonInit>[1],
) =>
  await harness.json(api(slug, path), {
    ...(body === undefined ? { method } : jsonInit(method, body)),
    ...who,
  });

const errorOf = (reply: { body: unknown }) => (reply.body as { error?: string }).error;

/** An org of its own with an admin and two plain members; answers its id and slug and how to act as each. */
const staffedOrg = async (prefix: string) => {
  const slug = `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  const admin = await as(ADMIN);
  const created = await harness.json("/v8/management/orgs", jsonInit("POST", { slug, name: slug }));

  expect(created.status).toBe(201);
  const org = OrgId.make((created.body as { id: string }).id);

  const add = async (email: string, role: string) => {
    const reply = await send(slug, "/members", admin, "POST", { email, role });

    expect(reply.status).toBe(201);

    return { id: (reply.body as { id: string }).id, email, ...(await as(email)) };
  };

  return {
    org,
    slug,
    platformAdmin: admin,
    admin: await add(`admin-${slug}@example.com`, "admin"),
    alice: await add(`alice-${slug}@example.com`, "member"),
    bob: await add(`bob-${slug}@example.com`, "member"),
  };
};

/** Creates a key as `who` and answers the creation's body (with the whole key). */
const createKey = async (slug: string, who: Auth, name = "laptop"): Promise<KeyBody> => {
  const reply = await send(slug, "/proxy-keys", who, "POST", { name });

  expect(reply.status).toBe(201);

  return reply.body as KeyBody;
};

const wholeKey = (created: KeyBody): string => {
  if (created.key === undefined) throw new Error("the creation did not answer the key");

  return created.key;
};

/** A proxy route called with `headers` only: no Access sign-in. */
const proxy = async (path: string, headers: Record<string, string>, method = "GET") =>
  await harness.json(path, { method, headers, auth: false });

describe("the key text", () => {
  it("names its org and id, carries at least 256 bits of secret, and parses back", () => {
    const org = OrgId.make("acme-1");
    const minted = mintProxyKey(org);
    const [, orgPart, id, secret] = /^cfp_([a-z0-9-]+)_([0-9a-f]{20})_(.+)$/.exec(minted.key) ?? [];

    expect(orgPart).toBe("acme-1");
    expect(id).toBe(minted.keyId);
    // base64url: 6 bits per character.
    expect((secret ?? "").length * 6).toBeGreaterThanOrEqual(256);
    expect(minted.prefix).toBe(`cfp_acme-1_${minted.keyId}_${(secret ?? "").slice(0, 4)}`);
    expect(parseProxyKey(minted.key)).toEqual({ org, keyId: minted.keyId, hash: minted.hash });
    expect(mintProxyKey(org).key).not.toBe(minted.key);

    for (const malformed of [
      "cfp_",
      "cfp_acme-1",
      `cfp_acme-1_${minted.keyId}`,
      `cfp_Acme_${minted.keyId}_${secret}`,
      `cfp_acme-1_${minted.keyId.slice(1)}_${secret}`,
      `cfp_acme-1_${minted.keyId}_${(secret ?? "").slice(1)}`,
      `sk-${minted.key}`,
    ])
      expect(parseProxyKey(malformed), malformed).toBeUndefined();
  });
});

describe("issuing keys", () => {
  it("shows a new key once and lists it by its prefix only", async () => {
    const { org, slug, alice } = await staffedOrg("issue");
    const created = await createKey(slug, alice, "  laptop  ");

    expect(wholeKey(created).startsWith(`cfp_${org}_${created.id}_`)).toBe(true);
    expect(created).toMatchObject({ name: "laptop", member_id: alice.id, mine: true });
    expect(wholeKey(created).startsWith(created.prefix)).toBe(true);

    const listed = await send(slug, "/proxy-keys", alice);

    expect(listed.status).toBe(200);
    const keys = (listed.body as { keys: ReadonlyArray<KeyBody> }).keys;

    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ id: created.id, prefix: created.prefix, mine: true });
    expect(keys[0]).not.toHaveProperty("key");
    expect(JSON.stringify(listed.body)).not.toContain(wholeKey(created));
  });

  it("refuses a bad name or expiry, and a caller who is not a member of the org", async () => {
    const { slug, alice, platformAdmin } = await staffedOrg("issue-refusals");

    const noName = await send(slug, "/proxy-keys", alice, "POST", { name: " " });
    expect([noName.status, errorOf(noName)]).toEqual([422, "invalid_name"]);

    const past = await send(slug, "/proxy-keys", alice, "POST", {
      name: "old",
      expires_at: "2001-01-01T00:00:00Z",
    });

    expect([past.status, errorOf(past)]).toEqual([422, "invalid_expiry"]);

    const garbled = await send(slug, "/proxy-keys", alice, "POST", {
      name: "x",
      expires_at: "soon",
    });

    expect([garbled.status, errorOf(garbled)]).toEqual([422, "invalid_expiry"]);

    // A platform admin manages every org but is a member of none of them here: keys go to members only.
    const outsider = await send(slug, "/proxy-keys", platformAdmin, "POST", { name: "admin" });
    expect([outsider.status, errorOf(outsider)]).toEqual([403, "member_required"]);
  });

  it("lets members list and revoke their own keys, and org admins every key", async () => {
    const { slug, admin, alice, bob } = await staffedOrg("issue-scope");
    const alices = await createKey(slug, alice);
    const bobs = await createKey(slug, bob);

    const aliceSees = (await send(slug, "/proxy-keys", alice)).body as { keys: Array<KeyBody> };
    expect(aliceSees.keys.map((key) => key.id)).toEqual([alices.id]);

    const adminSees = (await send(slug, "/proxy-keys", admin)).body as { keys: Array<KeyBody> };
    expect(new Set(adminSees.keys.map((key) => key.id))).toEqual(new Set([alices.id, bobs.id]));
    expect(adminSees.keys.find((key) => key.id === bobs.id)).toMatchObject({
      member_email: bob.email,
      mine: false,
    });

    // Another member's key is not there for a plain member.
    const foreign = await send(slug, `/proxy-keys/${bobs.id}`, alice, "DELETE");
    expect([foreign.status, errorOf(foreign)]).toEqual([404, "proxy_key_not_found"]);

    const own = await send(slug, `/proxy-keys/${alices.id}`, alice, "DELETE");
    expect(own.status).toBe(200);
    expect((own.body as KeyBody).revoked_at).toBeDefined();

    const byAdmin = await send(slug, `/proxy-keys/${bobs.id}`, admin, "DELETE");
    expect(byAdmin.status).toBe(200);

    // Revoked keys stay listed, marked.
    const after = (await send(slug, "/proxy-keys", alice)).body as { keys: Array<KeyBody> };
    expect(after.keys[0]?.revoked_at).toBeDefined();
  });

  it("holds a member to 100 live keys and drops their longest-dead key to make room", async () => {
    const { org, alice } = await staffedOrg("issue-limit");
    const stub = controlPlaneOf(env, org);
    const now = Date.now();

    const issue = async (name: string, at: number) => {
      const issued = await stub.createProxyKey({ memberId: alice.id, name }, at);

      if (!issued.ok) throw new Error(issued.message);

      return issued.value.record.id;
    };

    const ids: Array<string> = [];

    for (let index = 0; index < MAX_KEYS_PER_MEMBER; index++)
      ids.push(await issue(`key ${index}`, now + index));

    const full = await stub.createProxyKey({ memberId: alice.id, name: "one more" }, now + 200);
    expect(full).toMatchObject({ ok: false, error: "too_many_keys" });

    // Two revoked keys: the one revoked first gives up its row; the other stays listed.
    const [first, second] = [ids[7] ?? "", ids[3] ?? ""];
    await stub.revokeProxyKey(first, now + 300);
    await stub.revokeProxyKey(second, now + 301);
    const added = await issue("replacement", now + 400);

    const listed = (await stub.listProxyKeys(alice.id)).map((key) => key.id);
    expect(listed).toHaveLength(MAX_KEYS_PER_MEMBER);
    expect(listed).toContain(added);
    expect(listed).toContain(second);
    expect(listed).not.toContain(first);
  });
});

describe("the gate on the proxy routes", () => {
  it("takes a key in each header form a client sends, as its member in its org", async () => {
    const { org, slug, alice } = await staffedOrg("gate-forms");
    const created = await createKey(slug, alice);
    const key = wholeKey(created);

    const forms: ReadonlyArray<readonly [string, string, Record<string, string>]> = [
      ["GET", "/v1/models", { authorization: `Bearer ${key}` }],
      ["POST", "/v1/messages", { "x-api-key": key }],
      ["GET", "/v1beta/models", { "x-goog-api-key": key }],
      ["GET", `/v1beta/models?key=${encodeURIComponent(key)}`, {}],
      ["POST", "/openai/v1/chat/completions", { authorization: `bearer ${key}` }],
      ["POST", "/backend-api/codex/responses", { authorization: `Bearer ${key}` }],
      ["POST", "/responses", { "x-api-key": key }],
      // An old shared key in one header does not hide a proxy key in another.
      ["GET", "/v1/models", { authorization: "Bearer sk-dummy", "x-api-key": key }],
    ];

    for (const [method, path, headers] of forms) {
      const reply = await proxy(path, headers, method);

      expect(reply.status, `${method} ${path}`).toBe(200);
      expect(reply.body).toMatchObject({
        principal_id: `key:${created.id}`,
        org,
        member_id: alice.id,
        role: "member",
      });
    }

    const listed = (await send(slug, "/proxy-keys", alice)).body as { keys: Array<KeyBody> };
    expect(listed.keys[0]?.last_used_at).toBeDefined();
  });

  it("gives one member's keys one caller scope, apart from another member's", async () => {
    const { slug, alice, bob } = await staffedOrg("gate-scope");

    const scopeOf = async (key: KeyBody) =>
      ((await proxy("/v1/models", { authorization: `Bearer ${wholeKey(key)}` })).body as Seen)
        .caller_scope;

    const laptop = await scopeOf(await createKey(slug, alice, "laptop"));
    const desktop = await scopeOf(await createKey(slug, alice, "desktop"));
    const bobs = await scopeOf(await createKey(slug, bob));

    expect(laptop).toMatch(/^[0-9a-f]{64}$/);
    expect(desktop).toBe(laptop);
    expect(bobs).not.toBe(laptop);
  });

  it("answers wrong, unknown, revoked and expired keys with Invalid API key", async () => {
    const { org, slug, alice } = await staffedOrg("gate-refusals");
    const other = await staffedOrg("gate-refusals-other");
    const key = wholeKey(await createKey(slug, alice));
    const parsed = parseProxyKey(key);

    if (parsed === undefined) throw new Error("the issued key does not parse");
    const secret = key.slice(`cfp_${org}_${parsed.keyId}_`.length);
    const flipped = `${secret.slice(0, -1)}${secret.endsWith("A") ? "B" : "A"}`;

    const revoked = await createKey(slug, alice, "revoked");
    expect((await send(slug, `/proxy-keys/${revoked.id}`, alice, "DELETE")).status).toBe(200);

    // An expired key: issued directly, already past its expiry.
    const now = Date.now();

    const expired = await controlPlaneOf(env, org).createProxyKey(
      { memberId: alice.id, name: "expired", expiresAt: now - 1000 },
      now - 2000,
    );

    if (!expired.ok) throw new Error(expired.message);

    const refused = {
      "wrong org prefix": `cfp_${other.org}_${parsed.keyId}_${secret}`,
      "org that does not exist": `cfp_no-such-org_${parsed.keyId}_${secret}`,
      "unknown key": mintProxyKey(org).key,
      "wrong secret": `cfp_${org}_${parsed.keyId}_${flipped}`,
      revoked: wholeKey(revoked),
      expired: expired.value.key,
      malformed: "cfp_definitely-not-a-key",
    };

    for (const [why, presented] of Object.entries(refused)) {
      const reply = await proxy("/v1/models", { authorization: `Bearer ${presented}` });

      expect([reply.status, reply.body], why).toEqual([401, { error: "Invalid API key" }]);
    }

    // A refused key is not saved by an Access sign-in sent with it.
    const withJwt = await harness.json("/v1/models", {
      headers: { authorization: `Bearer ${wholeKey(revoked)}` },
      auth: await token(alice.email),
    });

    expect(withJwt.status).toBe(401);

    expect(await proxy("/v1/models", {})).toMatchObject({
      status: 401,
      body: { error: "Missing API key" },
    });
  });

  it("never takes a key of one org to another org's ControlPlane", async () => {
    const a = await staffedOrg("gate-org-a");
    const b = await staffedOrg("gate-org-b");
    const keyA = wholeKey(await createKey(a.slug, a.alice));
    const keyB = wholeKey(await createKey(b.slug, b.alice));
    const parsedA = parseProxyKey(keyA);

    if (parsedA === undefined) throw new Error("the issued key does not parse");

    expect(((await proxy("/v1/models", { "x-api-key": keyA })).body as Seen).org).toBe(a.org);
    expect(((await proxy("/v1/models", { "x-api-key": keyB })).body as Seen).org).toBe(b.org);

    // Org B's ControlPlane does not know org A's key, even asked directly.
    expect(
      await controlPlaneOf(env, b.org).verifyProxyKey(parsedA.keyId, parsedA.hash, Date.now()),
    ).toEqual({ ok: false, reason: "unknown" });

    // Asked through the gate with B's org in front of A's key: refused, and B records no use of any key.
    const relabelled = keyA.replace(`cfp_${a.org}_`, `cfp_${b.org}_`);
    expect((await proxy("/v1/models", { "x-api-key": relabelled })).status).toBe(401);

    const bKeys = (await send(b.slug, "/proxy-keys", b.admin)).body as { keys: Array<KeyBody> };
    expect(bKeys.keys.map((key) => key.id)).not.toContain(parsedA.keyId);
  });

  it("refuses a revoked key at once in the isolate that revoked it, and a removed member's keys", async () => {
    const { slug, admin, alice, bob } = await staffedOrg("gate-revoke");
    const created = await createKey(slug, alice);
    const headers = { authorization: `Bearer ${wholeKey(created)}` };

    // Verified, so cached.
    expect((await proxy("/v1/models", headers)).status).toBe(200);
    expect((await send(slug, `/proxy-keys/${created.id}`, alice, "DELETE")).status).toBe(200);
    expect((await proxy("/v1/models", headers)).status).toBe(401);

    const bobs = { "x-api-key": wholeKey(await createKey(slug, bob)) };
    expect((await proxy("/v1/models", bobs)).status).toBe(200);
    expect((await send(slug, `/members/${bob.id}`, admin, "DELETE")).status).toBe(200);
    expect((await proxy("/v1/models", bobs)).status).toBe(401);
  });

  it("never takes a key on the management routes", async () => {
    const { slug, alice } = await staffedOrg("gate-management");
    const key = wholeKey(await createKey(slug, alice));

    for (const headers of [{ authorization: `Bearer ${key}` }, { "x-api-key": key }]) {
      const reply = await harness.json(api(slug, "/proxy-keys"), { headers, auth: false });

      expect([reply.status, reply.body]).toEqual([401, { error: "Missing API key" }]);
    }
  });
});

describe("Access sign-ins on the proxy routes", () => {
  const owner = () => as(ADMIN);

  const setAccessClients = async (on: boolean) => {
    const reply = await harness.json("/v8/management/membership", {
      ...jsonInit("PATCH", { access_clients: on }),
      ...(await owner()),
    });

    expect(reply.status).toBe(200);

    return reply.body;
  };

  it("stay accepted in global, where clients signed in through Access before, and nowhere else", async () => {
    expect((await harness.json("/v8/management/membership", await owner())).body).toEqual({
      auto_join: true,
      access_clients: true,
    });

    const { slug } = await staffedOrg("access-default");
    // An Access sign-in on a proxy route names no org, so it only ever reaches global: other orgs lack the setting.
    expect((await send(slug, "/membership", await owner())).body).toEqual({ auto_join: false });
  });

  it("take the cloudflared header while global accepts them, and 401 once it does not", async () => {
    const jwt = await token("client@example.com");

    // `cloudflared access` sends the token in `cf-access-token`; clients often send a dummy key next to it.
    for (const headers of [
      { "cf-access-token": jwt },
      { "cf-access-token": jwt, authorization: "Bearer sk-dummy" },
      { "cf-access-token": jwt, "x-api-key": "sk-dummy" },
    ]) {
      const reply = await proxy("/v1/models", headers);

      expect(reply.status).toBe(200);
      expect((reply.body as Seen).principal_id).toBe("user:client@example.com");
    }

    expect(await setAccessClients(false)).toMatchObject({ access_clients: false });

    try {
      expect(await proxy("/v1/models", { "cf-access-token": jwt })).toMatchObject({
        status: 401,
        body: { error: "Missing API key" },
      });

      const viaEdge = await harness.json("/v1/models", { auth: jwt });
      expect([viaEdge.status, viaEdge.body]).toEqual([401, { error: "Missing API key" }]);

      const withDummy = await proxy("/v1/models", {
        "cf-access-token": jwt,
        authorization: "Bearer sk-dummy",
      });

      expect([withDummy.status, withDummy.body]).toEqual([401, { error: "Invalid API key" }]);

      // Not even a platform admin's or a service token's sign-in is a client credential then.
      expect((await harness.json("/v1/models", { auth: await token(ADMIN) })).status).toBe(401);
      expect(
        (await harness.json("/v1/models", { auth: await serviceToken("bot.access") })).status,
      ).toBe(401);

      // The management routes still take Access, and only Access.
      expect((await harness.json("/v8/management/membership", await owner())).status).toBe(200);
    } finally {
      await setAccessClients(true);
    }
  });

  it("are checked as strictly as the Access edge checks them: signature, audience, issuer and expiry", async () => {
    const now = Math.floor(Date.now() / 1000);
    const claims = userClaims("client@example.com");
    const impostor = await makeKey(managementKey.kid);

    const refused = {
      "bad signature": await signToken({ key: impostor, now, claims }),
      "unknown key id": await signToken({ key: impostor, kid: "nobody", now, claims }),
      "another application's audience": await signToken({
        key: managementKey,
        audience: "another-app",
        now,
        claims,
      }),
      "another team": await signToken({
        key: managementKey,
        issuer: "https://other.cloudflareaccess.com",
        now,
        claims,
      }),
      expired: await signToken({ key: managementKey, now: now - 7200, expiresIn: 3600, claims }),
      "not yet valid": await signToken({ key: managementKey, now, notBefore: now + 600, claims }),
    };

    for (const [why, jwt] of Object.entries(refused))
      for (const headers of [
        { "cf-access-token": jwt, authorization: "Bearer sk-dummy" },
        { "cf-access-jwt-assertion": jwt },
      ]) {
        const reply = await proxy("/v1/models", headers);

        expect([reply.status, reply.body], why).toEqual([401, { error: "Invalid API key" }]);
      }

    // The same claims, signed properly for this application, pass.
    const valid = await signToken({ key: managementKey, now, claims });

    expect(
      (await proxy("/v1/models", { "cf-access-token": valid, authorization: "Bearer sk-dummy" }))
        .status,
    ).toBe(200);
  });

  it("are changed by org owners only", async () => {
    const { slug, admin } = await staffedOrg("access-owner");
    const reply = await send(slug, "/membership", admin, "PATCH", { access_clients: true });

    expect([reply.status, errorOf(reply)]).toEqual([403, "owner_required"]);

    const elsewhere = await send(slug, "/membership", await owner(), "PATCH", {
      access_clients: true,
    });

    expect([elsewhere.status, errorOf(elsewhere)]).toEqual([422, "access_clients_global_only"]);

    try {
      // Changing one setting keeps the other.
      expect(await setAccessClients(false)).toEqual({ auto_join: true, access_clients: false });
    } finally {
      await setAccessClients(true);
    }
  });
});

describe("the verified-key cache", () => {
  const NOW_MS = 1_800_000_000_000;

  const context = requestContext(
    { ...env, ...registry.bindings, ACCESS_TEAM_DOMAIN: "team", ACCESS_AUD: "unused" },
    {} as unknown as ExecutionContext,
  );

  const run = <A, E>(body: Effect.Effect<A, E, WorkerEnv | AccessJwks | CurrentOrg>) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);

      return yield* body.pipe(
        Effect.provide(fakeJwksLayer(makeFakeJwks([accessKey]))),
        Effect.provideContext(context),
      );
    });

  effectIt.effect("lets a key revoked in another isolate through for at most its window", () =>
    run(
      Effect.gen(function* () {
        const slug = `cache-${crypto.randomUUID().slice(0, 8)}`;

        const org = yield* Effect.promise(async () => {
          const created = await registry.platform.createOrg({ slug, name: slug }, NOW_MS);

          if (!created.ok) throw new Error(created.message);

          return created.org.id;
        });

        const stub = controlPlaneOf(env, org);

        const key = yield* Effect.promise(async () => {
          const member = await stub.addMember(
            { email: "carol@example.com", role: "member" },
            { role: "owner", sensitive: true },
            "test",
          );

          if (!member.ok) throw new Error(member.message);

          const issued = await stub.createProxyKey(
            { memberId: member.value.id, name: "cli" },
            NOW_MS,
          );

          if (!issued.ok) throw new Error(issued.message);

          return issued.value;
        });

        const headers = { authorization: `Bearer ${key.key}` };
        const url = "https://proxy.test/v1/models";
        const identity = yield* authenticateRequest(headers, url, "protected");

        assert.strictEqual(identity.principalId, `key:${key.record.id}`);
        assert.strictEqual(identity.org, org);

        // Revoked behind this isolate's back (another isolate's request).
        yield* Effect.promise(async () => await stub.revokeProxyKey(key.record.id, NOW_MS));

        yield* TestClock.adjust(VERIFIED_KEY_TTL_MS - 1);
        assert.strictEqual((yield* authenticateRequest(headers, url, "protected")).org, org);

        yield* TestClock.adjust(1);
        const refused = yield* Effect.flip(authenticateRequest(headers, url, "protected"));

        assert.strictEqual(refused._tag, "UnauthorizedError");
        assert.strictEqual(refused.message, "Invalid API key");
        assert.isAtMost(VERIFIED_KEY_TTL_MS, 60_000);
      }),
    ),
  );
});
