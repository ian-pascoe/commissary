import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import { authenticateRequest } from "../src/access/authenticate.ts";
import { devBypass, devBypassEmail, isAdmin, loadAccessConfig } from "../src/access/config.ts";
import { JWKS_REFRESH_COOLDOWN_MS } from "../src/access/jwks.ts";
import { callerScope, makeIdentity, principalId } from "../src/access/principal.ts";
import { classifyPath } from "../src/access/routes.ts";
import { verifyAccessJwt } from "../src/access/verify.ts";
import { requestContext } from "../src/platform/env.ts";
import {
  AUD,
  fakeJwksLayer,
  ISSUER,
  JWKS_URL,
  makeFakeJwks,
  makeKey,
  serviceClaims,
  signToken,
  userClaims,
} from "./support/access.ts";
import type { FakeJwks, TestKey } from "./support/access.ts";
import { env } from "cloudflare:workers";
import { controlPlaneOf, GLOBAL_ORG, OrgId } from "../src/platform/org.ts";
import { platformOf } from "../src/platform/registry.ts";

const NOW_MS = 1_700_000_000_000;

const NOW = NOW_MS / 1000;

const config = { issuer: ISSUER, jwksUrl: JWKS_URL, audiences: [AUD] };

const keyA = await makeKey("kid-a");

const keyB = await makeKey("kid-b");

/** Runs `body` at a fixed virtual time with one JWKS cache shared by every verification inside it. */
const withJwks = <A, E>(
  state: FakeJwks,
  body: Effect.Effect<A, E, import("../src/access/jwks.ts").AccessJwks>,
): Effect.Effect<A, E> =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW_MS);

    return yield* body.pipe(Effect.provide(fakeJwksLayer(state)));
  });

/** Who adds the members these tests need: an org owner with the sensitive powers. */
const OWNER = { role: "owner", sensitive: true } as const;

/** Makes `email` a member of `org` with `role` (the member routes are tested in members.test.ts). */
const addMember = (org: OrgId, email: string, role: "owner" | "admin" | "member") =>
  Effect.promise(async () => {
    const added = await controlPlaneOf(env, org).addMember({ email, role }, OWNER, "test");

    if (!added.ok) throw new Error(added.message);

    return added.value;
  });

const token = (key: TestKey, overrides: Partial<Parameters<typeof signToken>[0]> = {}) =>
  Effect.promise(() =>
    signToken({ key, now: NOW, claims: userClaims("alice@example.com"), ...overrides }),
  );

describe("verifyAccessJwt", () => {
  it.effect("accepts a valid user token", () =>
    withJwks(
      makeFakeJwks([keyA]),
      Effect.gen(function* () {
        const principal = yield* verifyAccessJwt(yield* token(keyA), config);
        assert.deepStrictEqual(principal, {
          kind: "user",
          email: "alice@example.com",
          sub: "sub-alice@example.com",
        });
      }),
    ),
  );

  it.effect("accepts a valid service token", () =>
    withJwks(
      makeFakeJwks([keyA]),
      Effect.gen(function* () {
        const jwt = yield* token(keyA, { claims: serviceClaims("abc123.access") });
        const principal = yield* verifyAccessJwt(jwt, config);
        assert.deepStrictEqual(principal, { kind: "service", commonName: "abc123.access" });
      }),
    ),
  );

  it.effect("accepts any configured audience and tokens with several aud values", () =>
    withJwks(
      makeFakeJwks([keyA]),
      Effect.gen(function* () {
        const jwt = yield* token(keyA, { audience: ["other", "aud-tag-2"] });
        const principal = yield* verifyAccessJwt(jwt, { ...config, audiences: [AUD, "aud-tag-2"] });
        assert.strictEqual(principal.kind, "user");
      }),
    ),
  );

  it.effect("rejects a wrong audience", () =>
    withJwks(
      makeFakeJwks([keyA]),
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          verifyAccessJwt(yield* token(keyA, { audience: "nope" }), config),
        );

        assert.strictEqual(error._tag, "UnauthorizedError");
        assert.strictEqual(error.message, "Invalid API key");
      }),
    ),
  );

  it.effect("rejects a wrong issuer", () =>
    withJwks(
      makeFakeJwks([keyA]),
      Effect.gen(function* () {
        const jwt = yield* token(keyA, { issuer: "https://evil.cloudflareaccess.com" });
        const error = yield* Effect.flip(verifyAccessJwt(jwt, config));
        assert.strictEqual(error._tag, "UnauthorizedError");
      }),
    ),
  );

  it.effect("rejects an expired token but tolerates small clock skew", () =>
    withJwks(
      makeFakeJwks([keyA]),
      Effect.gen(function* () {
        // exp = now - 10s: inside the 30s skew.
        const skewed = yield* token(keyA, { now: NOW - 3610 });
        assert.strictEqual((yield* verifyAccessJwt(skewed, config)).kind, "user");
        // exp = now - 120s: expired.
        const expired = yield* token(keyA, { now: NOW - 3720 });
        assert.strictEqual(
          (yield* Effect.flip(verifyAccessJwt(expired, config)))._tag,
          "UnauthorizedError",
        );
      }),
    ),
  );

  it.effect("rejects a token that is not valid yet (nbf)", () =>
    withJwks(
      makeFakeJwks([keyA]),
      Effect.gen(function* () {
        const future = yield* token(keyA, { notBefore: NOW + 300 });
        assert.strictEqual(
          (yield* Effect.flip(verifyAccessJwt(future, config)))._tag,
          "UnauthorizedError",
        );
        const nearFuture = yield* token(keyA, { notBefore: NOW + 10 });
        assert.strictEqual((yield* verifyAccessJwt(nearFuture, config)).kind, "user");
      }),
    ),
  );

  it.effect("rejects a token signed by a different key with a known kid", () =>
    withJwks(
      makeFakeJwks([keyA]),
      Effect.gen(function* () {
        const forged = yield* token(keyB, { kid: "kid-a" });
        assert.strictEqual(
          (yield* Effect.flip(verifyAccessJwt(forged, config)))._tag,
          "UnauthorizedError",
        );
      }),
    ),
  );

  it.effect("rejects malformed tokens and tokens without claims identifying a principal", () =>
    withJwks(
      makeFakeJwks([keyA]),
      Effect.gen(function* () {
        for (const bad of ["", "not-a-jwt", "a.b.c", "eyJhbGciOiJub25lIn0.e30."]) {
          assert.strictEqual(
            (yield* Effect.flip(verifyAccessJwt(bad, config)))._tag,
            "UnauthorizedError",
          );
        }

        const anonymous = yield* token(keyA, { claims: {} });
        assert.strictEqual(
          (yield* Effect.flip(verifyAccessJwt(anonymous, config)))._tag,
          "UnauthorizedError",
        );
      }),
    ),
  );

  it.effect("refetches the JWKS for an unknown kid, at most once per cooldown", () => {
    const state = makeFakeJwks([keyA]);

    return withJwks(
      state,
      Effect.gen(function* () {
        yield* verifyAccessJwt(yield* token(keyA), config);
        assert.strictEqual(state.fetches, 1);

        // Key rotation: B is published after the first fetch. Inside the cooldown the unknown kid is rejected
        // without hitting the endpoint.
        state.keys = [keyA.jwk, keyB.jwk];
        const early = yield* Effect.flip(verifyAccessJwt(yield* token(keyB), config));
        assert.strictEqual(early._tag, "UnauthorizedError");
        assert.strictEqual(state.fetches, 1);

        yield* TestClock.adjust(JWKS_REFRESH_COOLDOWN_MS + 1);
        const principal = yield* verifyAccessJwt(yield* token(keyB, { now: NOW + 31 }), config);
        assert.strictEqual(principal.kind, "user");
        assert.strictEqual(state.fetches, 2);

        // Known kids are served from the cache.
        yield* verifyAccessJwt(yield* token(keyA, { now: NOW + 31 }), config);
        assert.strictEqual(state.fetches, 2);
      }),
    );
  });

  it.effect("fails with InternalError when the JWKS cannot be fetched, and recovers", () => {
    const state = makeFakeJwks([keyA]);
    state.fail = true;

    return withJwks(
      state,
      Effect.gen(function* () {
        const error = yield* Effect.flip(verifyAccessJwt(yield* token(keyA), config));
        assert.strictEqual(error._tag, "InternalError");
        state.fail = false;
        assert.strictEqual((yield* verifyAccessJwt(yield* token(keyA), config)).kind, "user");
      }),
    );
  });

  it.effect("keeps serving cached keys when a refresh fails", () => {
    const state = makeFakeJwks([keyA]);

    return withJwks(
      state,
      Effect.gen(function* () {
        yield* verifyAccessJwt(yield* token(keyA), config);
        state.fail = true;
        yield* TestClock.adjust(11 * 60_000);
        const jwt = yield* token(keyA, { now: NOW + 660 });
        assert.strictEqual((yield* verifyAccessJwt(jwt, config)).kind, "user");
        assert.strictEqual(state.fetches, 2);
      }),
    );
  });
});

describe("authenticateRequest", () => {
  const testEnv = {
    ...env,
    ACCESS_TEAM_DOMAIN: "team",
    ACCESS_AUD: AUD,
    PLATFORM_ADMIN_EMAILS: "Admin@Example.com",
    PLATFORM_ADMIN_SERVICE_TOKENS: "admin.access",
  };

  const context = requestContext(testEnv, {} as unknown as ExecutionContext);

  const run = <A, E>(
    state: FakeJwks,
    body: Effect.Effect<
      A,
      E,
      | import("../src/platform/env.ts").WorkerEnv
      | import("../src/access/jwks.ts").AccessJwks
      | import("../src/platform/org.ts").CurrentOrg
    >,
  ) => withJwks(state, body.pipe(Effect.provideContext(context)));

  it.effect("fails with Missing API key when the header is absent", () =>
    run(
      makeFakeJwks([keyA]),
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          authenticateRequest({}, "https://commissary.test/v1/models", "protected"),
        );

        assert.strictEqual(error._tag, "UnauthorizedError");
        assert.strictEqual(error.message, "Missing API key");
      }),
    ),
  );

  it.effect("derives the identity and enforces the admin allow-list for management", () =>
    run(
      makeFakeJwks([keyA]),
      Effect.gen(function* () {
        const url = "https://commissary.test/v9/management/config";
        const alice = { "cf-access-jwt-assertion": yield* token(keyA) };
        const identity = yield* authenticateRequest(alice, url, "protected");
        assert.strictEqual(identity.principalId, "user:alice@example.com");
        assert.strictEqual(
          identity.callerScope,
          "21cd36b03d03c619f37e1df80f5e22b7c4c9319b4e8151ea93327b51520a06e9",
        );
        assert.strictEqual(
          (yield* Effect.flip(authenticateRequest(alice, url, "management")))._tag,
          "ForbiddenError",
        );

        const admin = {
          "cf-access-jwt-assertion": yield* token(keyA, {
            claims: userClaims("ADMIN@example.com"),
          }),
        };

        assert.strictEqual(
          (yield* authenticateRequest(admin, url, "management")).principal.kind,
          "user",
        );

        const svc = {
          "cf-access-jwt-assertion": yield* token(keyA, { claims: serviceClaims("admin.access") }),
        };

        assert.strictEqual(
          (yield* authenticateRequest(svc, url, "management")).principalId,
          "service:admin.access",
        );

        const other = {
          "cf-access-jwt-assertion": yield* token(keyA, { claims: serviceClaims("other.access") }),
        };

        assert.strictEqual(
          (yield* Effect.flip(authenticateRequest(other, url, "management")))._tag,
          "ForbiddenError",
        );
      }),
    ),
  );

  it.effect("admits members with the role the route needs, and nobody once removed", () =>
    run(
      makeFakeJwks([keyA]),
      Effect.gen(function* () {
        const config = "https://commissary.test/v9/management/config";
        const usage = "https://commissary.test/v9/management/observability/usage/records";
        const stub = controlPlaneOf(env, GLOBAL_ORG);
        const carol = yield* addMember(GLOBAL_ORG, "carol@example.com", "admin");
        const dan = yield* addMember(GLOBAL_ORG, "dan@example.com", "member");

        const as = (email: string) =>
          token(keyA, { claims: userClaims(email) }).pipe(
            Effect.map((jwt) => ({ "cf-access-jwt-assertion": jwt })),
          );

        const asCarol = yield* as("Carol@Example.com");
        const identity = yield* authenticateRequest(asCarol, config, "management");
        assert.strictEqual(identity.role, "admin");
        assert.strictEqual(identity.memberId, carol.id);
        assert.isFalse(identity.platformAdmin);

        // A plain member reads usage and uses Commissary, but no admin route.
        const asDan = yield* as("dan@example.com");
        assert.strictEqual((yield* authenticateRequest(asDan, usage, "management")).role, "member");
        assert.strictEqual(
          (yield* Effect.flip(authenticateRequest(asDan, usage, "management", "DELETE")))._tag,
          "ForbiddenError",
        );
        assert.strictEqual(
          (yield* Effect.flip(authenticateRequest(asDan, config, "management")))._tag,
          "ForbiddenError",
        );
        assert.strictEqual(
          (yield* authenticateRequest(asDan, "https://commissary.test/v1/models", "protected"))
            .memberId,
          dan.id,
        );

        // Removed: refused on the next request.
        yield* Effect.promise(async () => await stub.removeMember(carol.id, OWNER));
        yield* Effect.promise(() => stub.setMembershipSettings({ autoJoin: false }));

        try {
          assert.strictEqual(
            (yield* Effect.flip(authenticateRequest(asCarol, config, "management")))._tag,
            "ForbiddenError",
          );
          assert.strictEqual(
            (yield* Effect.flip(
              authenticateRequest(asCarol, "https://commissary.test/v1/models", "protected"),
            ))._tag,
            "ForbiddenError",
          );
        } finally {
          yield* Effect.promise(() => stub.setMembershipSettings({ autoJoin: true }));
          yield* Effect.promise(async () => await stub.removeMember(dan.id, OWNER));
        }
      }),
    ),
  );

  it.effect("fails closed with a configuration error when Access is not configured", () =>
    withJwks(
      makeFakeJwks([keyA]),
      authenticateRequest({}, "https://commissary.test/v1/models", "protected").pipe(
        Effect.provideContext(
          requestContext(
            { ...env, ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" },
            {} as unknown as ExecutionContext,
          ),
        ),
        Effect.flip,
        Effect.map((error) => assert.strictEqual(error._tag, "ConfigurationError")),
      ),
    ),
  );
});

describe("authenticateRequest and orgs", () => {
  const testEnv = {
    ...env,
    ACCESS_TEAM_DOMAIN: "team",
    ACCESS_AUD: AUD,
    PLATFORM_ADMIN_EMAILS: "admin@example.com",
    PLATFORM_ADMIN_SERVICE_TOKENS: "",
  };

  const context = requestContext(testEnv, {} as unknown as ExecutionContext);

  const run = <A, E>(
    body: Effect.Effect<
      A,
      E,
      | import("../src/platform/env.ts").WorkerEnv
      | import("../src/access/jwks.ts").AccessJwks
      | import("../src/platform/org.ts").CurrentOrg
    >,
  ) => withJwks(makeFakeJwks([keyA]), body.pipe(Effect.provideContext(context)));

  const as = (email: string) =>
    Effect.promise(async () => ({
      "cf-access-jwt-assertion": await signToken({
        key: keyA,
        now: NOW,
        claims: userClaims(email),
      }),
    }));

  const registered = (slug: string) =>
    Effect.promise(async () => {
      const created = await platformOf(env).createOrg({ slug, name: slug }, NOW_MS);

      if (!created.ok) throw new Error(created.message);

      return created.org;
    });

  it.effect("gives a platform admin any org the registry lists, by its slug", () =>
    run(
      Effect.gen(function* () {
        const org = yield* registered("acme-access");
        const admin = yield* as("admin@example.com");

        const scoped = yield* authenticateRequest(
          admin,
          "https://commissary.test/v9/management/orgs/acme-access/config",
          "management",
        );

        assert.strictEqual(scoped.org, org.id);
        assert.isTrue(scoped.platformAdmin);
        // Its caller scope is the one of that org, not of `global`.
        assert.strictEqual(
          scoped.callerScope,
          yield* callerScope("user:admin@example.com", org.id),
        );

        const panel = yield* authenticateRequest(
          admin,
          "https://commissary.test/o/acme-access/accounts",
          "management",
        );

        assert.strictEqual(panel.org, org.id);

        const unscoped = yield* authenticateRequest(
          admin,
          "https://commissary.test/v9/management/config",
          "management",
        );

        assert.strictEqual(unscoped.org, GLOBAL_ORG);
        assert.isTrue(unscoped.platformAdmin);

        // Platform-level routes address no org.
        const platformLevel = yield* authenticateRequest(
          admin,
          "https://commissary.test/v9/management/orgs/acme-access",
          "management",
        );

        assert.strictEqual(platformLevel.org, GLOBAL_ORG);
      }),
    ),
  );

  it.effect("answers an unknown slug with 404 to a platform admin and 403 to anyone else", () =>
    run(
      Effect.gen(function* () {
        const url = "https://commissary.test/v9/management/orgs/nobody-here/config";

        assert.strictEqual(
          (yield* Effect.flip(
            authenticateRequest(yield* as("admin@example.com"), url, "management"),
          ))._tag,
          "NotFoundError",
        );
        assert.strictEqual(
          (yield* Effect.flip(
            authenticateRequest(yield* as("carol@example.com"), url, "management"),
          ))._tag,
          "ForbiddenError",
        );
        assert.strictEqual(
          (yield* Effect.flip(
            authenticateRequest(yield* as("dave@example.com"), url, "management"),
          ))._tag,
          "ForbiddenError",
        );
        // Not signed in: 401 before anything is looked up.
        assert.strictEqual(
          (yield* Effect.flip(authenticateRequest({}, url, "management")))._tag,
          "UnauthorizedError",
        );
      }),
    ),
  );

  it.effect("limits an org admin to the orgs they are a member of", () =>
    run(
      Effect.gen(function* () {
        yield* registered("acme-limits");
        const carol = yield* as("erin@example.com");
        yield* addMember(GLOBAL_ORG, "erin@example.com", "admin");

        const own = yield* authenticateRequest(
          carol,
          "https://commissary.test/v9/management/orgs/default/config",
          "management",
        );

        assert.strictEqual(own.org, GLOBAL_ORG);
        assert.isFalse(own.platformAdmin);

        assert.strictEqual(
          (yield* authenticateRequest(
            carol,
            "https://commissary.test/v9/management/config",
            "management",
          )).org,
          GLOBAL_ORG,
        );

        for (const url of [
          "https://commissary.test/v9/management/orgs/acme-limits/config",
          "https://commissary.test/o/acme-limits/accounts",
        ]) {
          assert.strictEqual(
            (yield* Effect.flip(authenticateRequest(carol, url, "management")))._tag,
            "ForbiddenError",
          );
        }
      }),
    ),
  );

  it.effect("marks the platform admins of a protected route without scoping it", () =>
    run(
      Effect.gen(function* () {
        const alice = yield* authenticateRequest(
          yield* as("alice@example.com"),
          "https://commissary.test/v1/models",
          "protected",
        );

        const admin = yield* authenticateRequest(
          yield* as("admin@example.com"),
          "https://commissary.test/v1/models",
          "protected",
        );

        assert.isFalse(alice.platformAdmin);
        assert.isTrue(admin.platformAdmin);
        assert.strictEqual(alice.org, GLOBAL_ORG);
      }),
    ),
  );
});

describe("principal", () => {
  it.effect("callerScope mirrors the Go derivation", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* callerScope("user:alice@example.com", GLOBAL_ORG),
        "21cd36b03d03c619f37e1df80f5e22b7c4c9319b4e8151ea93327b51520a06e9",
      );
      assert.strictEqual(
        yield* callerScope("service:abc.access", GLOBAL_ORG),
        "84a7bf2e7053ab5a89f0f60fc4e2fc30abb4cf0284421d8bb85ff4d38254733a",
      );
      assert.strictEqual(yield* callerScope("  ", GLOBAL_ORG), "");

      const identity = yield* makeIdentity(
        { kind: "service", commonName: "abc.access" },
        GLOBAL_ORG,
      );

      assert.strictEqual(
        identity.callerScope,
        "84a7bf2e7053ab5a89f0f60fc4e2fc30abb4cf0284421d8bb85ff4d38254733a",
      );
    }),
  );

  it.effect("callerScope keeps one principal's scopes in two orgs apart", () =>
    Effect.gen(function* () {
      const acme = yield* callerScope("user:alice@example.com", OrgId.make("acme"));
      const other = yield* callerScope("user:alice@example.com", OrgId.make("other"));
      assert.match(acme, /^[0-9a-f]{64}$/);
      assert.notStrictEqual(acme, other);
      assert.notStrictEqual(acme, yield* callerScope("user:alice@example.com", GLOBAL_ORG));
      assert.strictEqual(yield* callerScope("  ", OrgId.make("acme")), "");
    }),
  );

  it("principalId lowercases emails", () => {
    expect(principalId({ kind: "user", email: "Alice@Example.COM", sub: "s" })).toBe(
      "user:alice@example.com",
    );
  });
});

describe("config", () => {
  const base = {
    ACCESS_TEAM_DOMAIN: "",
    ACCESS_AUD: "",
    PLATFORM_ADMIN_EMAILS: "",
    PLATFORM_ADMIN_SERVICE_TOKENS: "",
  };

  it.effect("normalises the team domain and splits the lists", () =>
    Effect.gen(function* () {
      const loaded = yield* loadAccessConfig({
        ACCESS_TEAM_DOMAIN: "https://Team.cloudflareaccess.com/",
        ACCESS_AUD: "a1, a2\nb3",
        PLATFORM_ADMIN_EMAILS: "One@x.com,two@x.com",
        PLATFORM_ADMIN_SERVICE_TOKENS: "t1.access",
      });

      assert.strictEqual(loaded.issuer, "https://team.cloudflareaccess.com");
      assert.strictEqual(loaded.jwksUrl, "https://team.cloudflareaccess.com/cdn-cgi/access/certs");
      assert.deepStrictEqual(loaded.audiences, ["a1", "a2", "b3"]);
      assert.isTrue(isAdmin(loaded, { kind: "user", email: "ONE@x.com", sub: "" }));
      assert.isFalse(isAdmin(loaded, { kind: "user", email: "three@x.com", sub: "" }));
      assert.isTrue(isAdmin(loaded, { kind: "service", commonName: "t1.access" }));

      const short = yield* loadAccessConfig({
        ...base,
        ACCESS_TEAM_DOMAIN: "team",
        ACCESS_AUD: "a",
      });

      assert.strictEqual(short.issuer, "https://team.cloudflareaccess.com");
    }),
  );

  it.effect("rejects missing or invalid settings", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* Effect.flip(loadAccessConfig(base)))._tag, "ConfigurationError");
      const noAud = loadAccessConfig({ ...base, ACCESS_TEAM_DOMAIN: "team" });
      assert.strictEqual((yield* Effect.flip(noAud))._tag, "ConfigurationError");

      const badHost = loadAccessConfig({
        ...base,
        ACCESS_TEAM_DOMAIN: "evil.com/path?x",
        ACCESS_AUD: "a",
      });

      assert.strictEqual((yield* Effect.flip(badHost))._tag, "ConfigurationError");
    }),
  );

  it("dev bypass is honoured for loopback hosts only", () => {
    expect(
      devBypassEmail({ ACCESS_DEV_BYPASS: "" }, "http://localhost:8787/v1/models"),
    ).toBeUndefined();
    expect(devBypassEmail({ ACCESS_DEV_BYPASS: "true" }, "http://localhost:8787/v1/models")).toBe(
      "dev@localhost",
    );
    expect(devBypassEmail({ ACCESS_DEV_BYPASS: "me@x.com" }, "http://127.0.0.1:8787/")).toBe(
      "me@x.com",
    );
    expect(
      devBypassEmail({ ACCESS_DEV_BYPASS: "true" }, "https://proxy.example.com/v1/models"),
    ).toBeUndefined();
    expect(
      devBypassEmail({ ACCESS_DEV_BYPASS: "true" }, "https://localhost.evil.com/v1/models"),
    ).toBeUndefined();
    // Never once Access is configured.
    const configured = { ACCESS_DEV_BYPASS: "true", ACCESS_TEAM_DOMAIN: "team", ACCESS_AUD: "" };
    expect(devBypassEmail(configured, "http://localhost:8787/v1/models")).toBeUndefined();
    expect(devBypass(configured, "http://localhost:8787/v1/models")?._tag).toBe("Refused");
    expect(
      devBypass({ ACCESS_DEV_BYPASS: "1", ACCESS_AUD: "aud" }, "http://127.0.0.1/")?._tag,
    ).toBe("Refused");
    const active = devBypass({ ACCESS_DEV_BYPASS: "1", ACCESS_AUD: " " }, "http://127.0.0.1/");
    expect(active?._tag).toBe("Active");
    expect(active).toMatchObject({ email: "dev@localhost" });
  });
});

describe("classifyPath", () => {
  it("classifies public, protected and management paths", () => {
    expect(classifyPath("https://x.test/healthz")).toBe("public");
    expect(classifyPath("https://x.test/")).toBe("management");
    expect(classifyPath("https://x.test/nope")).toBe("public");

    for (const path of [
      "/v1/chat/completions",
      "/v1",
      "/v1beta/models/gemini:generateContent",
      "/v1internal:generateContent",
      "/openai/v1/videos",
      "/backend-api/codex/responses",
    ]) {
      expect(classifyPath(`https://x.test${path}?q=1`)).toBe("protected");
    }

    expect(classifyPath("https://x.test/v9/management/config")).toBe("management");
  });

  it("is not fooled by alternative spellings", () => {
    expect(classifyPath("https://x.test//v1/models")).toBe("protected");
    expect(classifyPath("https://x.test/V1/models")).toBe("protected");
    expect(classifyPath("https://x.test/%76%31/models")).toBe("protected");
    expect(classifyPath("https://x.test/a/../v1/models")).toBe("protected");
    expect(classifyPath("https://x.test/V9/Management/x")).toBe("management");
    expect(classifyPath("https://x.test/%2576%31/models")).toBe("public");
  });
});
