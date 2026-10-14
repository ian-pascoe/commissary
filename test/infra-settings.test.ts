// Deploy settings (infra/settings.ts): the platform admins (PLATFORM_ADMIN_* and the deprecated ACCESS_ADMIN_* names
// they replace, which a deployment may still set), the secrets key generations and a hosted proxy's settings.
import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Logger, Redacted } from "effect";
import { readSettings } from "../infra/settings.ts";

const read = (variables: Record<string, string>, deployed?: { readonly stage: string }) => {
  const warnings: Array<string> = [];

  const capture = Logger.layer([
    Logger.make(({ logLevel, message }) => {
      if (logLevel === "Warn") warnings.push([message].flat().map(String).join(" "));
    }),
  ]);

  return readSettings(deployed === undefined, deployed?.stage ?? "dev").pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(variables))),
    Effect.provide(capture),
    Effect.map((settings) => ({ settings, warnings })),
  );
};

describe("platform admin settings", () => {
  it.effect("reads PLATFORM_ADMIN_* without a warning", () =>
    Effect.gen(function* () {
      const { settings, warnings } = yield* read({
        PLATFORM_ADMIN_EMAILS: "a@x.com, b@x.com",
        PLATFORM_ADMIN_SERVICE_TOKENS: "ops",
      });

      assert.deepStrictEqual(settings.adminEmails, ["a@x.com", "b@x.com"]);
      assert.deepStrictEqual(settings.adminServiceTokens, ["ops"]);
      assert.deepStrictEqual(warnings, []);
    }),
  );

  it.effect("still reads ACCESS_ADMIN_*, merged with the new names and with a warning each", () =>
    Effect.gen(function* () {
      const { settings, warnings } = yield* read({
        PLATFORM_ADMIN_EMAILS: "new@x.com",
        ACCESS_ADMIN_EMAILS: "old@x.com new@x.com",
        ACCESS_ADMIN_SERVICE_TOKENS: "legacy",
      });

      assert.deepStrictEqual(settings.adminEmails, ["new@x.com", "old@x.com"]);
      assert.deepStrictEqual(settings.adminServiceTokens, ["legacy"]);
      assert.strictEqual(warnings.length, 2);
      assert.include(
        warnings[0],
        "ACCESS_ADMIN_EMAILS is deprecated: rename it to PLATFORM_ADMIN_EMAILS",
      );
      assert.include(
        warnings[1],
        "ACCESS_ADMIN_SERVICE_TOKENS is deprecated: rename it to PLATFORM_ADMIN_SERVICE_TOKENS",
      );
    }),
  );
});

describe("secrets key generations", () => {
  it.effect(
    "default to generation 1 and no rotation, also when CI passes unset variables as empty",
    () =>
      Effect.gen(function* () {
        for (const variables of [
          {},
          { SECRETS_KEY_GENERATION: "", SECRETS_KEY_PREVIOUS_GENERATION: "" },
        ]) {
          const { settings } = yield* read(variables);

          assert.strictEqual(settings.secretsKeyGeneration, 1);
          assert.strictEqual(settings.secretsKeyPreviousGeneration, undefined);
        }
      }),
  );

  it.effect("read a rotation from an older generation to a newer one", () =>
    Effect.gen(function* () {
      const { settings } = yield* read({
        SECRETS_KEY_GENERATION: "3",
        SECRETS_KEY_PREVIOUS_GENERATION: "2",
      });

      assert.strictEqual(settings.secretsKeyGeneration, 3);
      assert.strictEqual(settings.secretsKeyPreviousGeneration, 2);
    }),
  );

  it.effect("refuse a generation that is not a positive integer, or a previous one not older", () =>
    Effect.gen(function* () {
      for (const [variables, message] of [
        [{ SECRETS_KEY_GENERATION: "0" }, "SECRETS_KEY_GENERATION must be a positive integer"],
        [{ SECRETS_KEY_GENERATION: "2.5" }, "SECRETS_KEY_GENERATION must be a positive integer"],
        [
          { SECRETS_KEY_PREVIOUS_GENERATION: "1" },
          "SECRETS_KEY_PREVIOUS_GENERATION (1) must be lower than SECRETS_KEY_GENERATION (1)",
        ],
        [
          { SECRETS_KEY_GENERATION: "2", SECRETS_KEY_PREVIOUS_GENERATION: "3" },
          "must be lower than SECRETS_KEY_GENERATION (2)",
        ],
      ] as const) {
        // The settings refuse invalid values as a defect with a readable message (see `readSettings`).
        const refusal = yield* read(variables).pipe(
          Effect.as("accepted"),
          Effect.catchDefect((defect) => Effect.succeed(String(defect))),
        );

        assert.include(refusal, message);
      }
    }),
  );
});

describe("hosted proxy settings", () => {
  const hosted = {
    PROXY_MODE: "hosted",
    CF_LLM_PROXY_DOMAIN: "proxy.example.com",
    SIGN_IN_GITHUB_CLIENT_ID: "gh-id",
    SIGN_IN_GITHUB_CLIENT_SECRET: "gh-secret",
    TURNSTILE_SITE_KEY: "site",
    TURNSTILE_SECRET_KEY: "turnstile-secret",
  };

  const refusal = (variables: Record<string, string>) =>
    read(variables, { stage: "prod" }).pipe(
      Effect.as("accepted"),
      Effect.catchDefect((defect) => Effect.succeed(String(defect))),
    );

  it.effect("need no Access settings, and default the org limits", () =>
    Effect.gen(function* () {
      const { settings } = yield* read(hosted, { stage: "prod" });

      assert.strictEqual(settings.hosted?.githubClientId, "gh-id");
      assert.strictEqual(
        Redacted.value(settings.hosted?.githubClientSecret ?? Redacted.make("")),
        "gh-secret",
      );
      assert.strictEqual(settings.hosted?.googleClientId, "");
      assert.strictEqual(settings.hosted?.ownedOrgLimit, "3");
      assert.strictEqual(settings.hosted?.orgRateLimit, 600);
      assert.strictEqual(settings.hosted?.orgRateLimitNamespaceId, 7201);
    }),
  );

  it.effect("are not read on a self-hosted proxy or in `alchemy dev`", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* read({ ...hosted, PROXY_MODE: "" })).settings.hosted, undefined);
      assert.strictEqual((yield* read(hosted)).settings.hosted, undefined);
      assert.include(
        yield* refusal({ ...hosted, PROXY_MODE: "self-hosted" }),
        "ACCESS_TEAM_DOMAIN is required",
      );
    }),
  );

  it.effect("are required on the hosted stage, which never deploys a self-hosted proxy", () =>
    Effect.gen(function* () {
      const { settings } = yield* read(hosted, { stage: "hosted" });

      assert.strictEqual(settings.hosted?.githubClientId, "gh-id");

      for (const mode of ["", "self-hosted"]) {
        const refused = yield* read(
          {
            ...hosted,
            PROXY_MODE: mode,
            ACCESS_TEAM_DOMAIN: "team",
            ACCESS_ALLOW_EMAILS: "a@x.com",
          },
          { stage: "hosted" },
        ).pipe(
          Effect.as("accepted"),
          Effect.catchDefect((defect) => Effect.succeed(String(defect))),
        );

        assert.include(refused, "the hosted stage is a hosted proxy: set PROXY_MODE=hosted");
      }
    }),
  );

  it.effect("refuse a hosted proxy without a sign-in provider, Turnstile or valid limits", () =>
    Effect.gen(function* () {
      for (const [variables, message] of [
        [{ PROXY_MODE: "managed" }, "PROXY_MODE must be self-hosted or hosted"],
        [{ SIGN_IN_GITHUB_CLIENT_SECRET: "" }, "a hosted proxy needs a sign-in provider"],
        [
          { TURNSTILE_SECRET_KEY: "" },
          "a hosted proxy needs TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY",
        ],
        [{ OWNED_ORG_LIMIT: "-1" }, "OWNED_ORG_LIMIT must be a whole number from 0"],
        [{ ORG_RATE_LIMIT: "0" }, "ORG_RATE_LIMIT must be a whole number from 1"],
        [
          { ORG_RATE_LIMIT_NAMESPACE_ID: "x" },
          "ORG_RATE_LIMIT_NAMESPACE_ID must be a positive integer",
        ],
        [{ CF_LLM_PROXY_DOMAIN: "" }, "CF_LLM_PROXY_DOMAIN is required"],
      ] as const)
        assert.include(yield* refusal({ ...hosted, ...variables }), message);
    }),
  );
});

describe("API host settings", () => {
  const selfHosted = {
    CF_LLM_PROXY_DOMAIN: "proxy.example.com",
    ACCESS_TEAM_DOMAIN: "team",
    ACCESS_ALLOW_EMAILS: "a@x.com",
  };

  const refusal = (variables: Record<string, string>, stage = "prod") =>
    read(variables, { stage }).pipe(
      Effect.as("accepted"),
      Effect.catchDefect((defect) => Effect.succeed(String(defect))),
    );

  it.effect("default to one host serving everything", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* read(selfHosted, { stage: "prod" })).settings.apiDomain, "");
    }),
  );

  it.effect("read CF_LLM_PROXY_API_DOMAIN, except on a preview and in `alchemy dev`", () =>
    Effect.gen(function* () {
      const split = { ...selfHosted, CF_LLM_PROXY_API_DOMAIN: " api.example.com " };

      assert.strictEqual(
        (yield* read(split, { stage: "prod" })).settings.apiDomain,
        "api.example.com",
      );
      assert.strictEqual((yield* read(split, { stage: "pr-12" })).settings.apiDomain, "");
      assert.strictEqual((yield* read(split)).settings.apiDomain, "");
    }),
  );

  it.effect("refuse an API host that is the app host or no hostname", () =>
    Effect.gen(function* () {
      for (const [apiDomain, message] of [
        ["proxy.example.com", "CF_LLM_PROXY_API_DOMAIN must differ from CF_LLM_PROXY_DOMAIN"],
        ["https://api.example.com", "CF_LLM_PROXY_API_DOMAIN must be a lowercase hostname"],
        ["api.example.com/v1", "CF_LLM_PROXY_API_DOMAIN must be a lowercase hostname"],
        ["API.example.com", "CF_LLM_PROXY_API_DOMAIN must be a lowercase hostname"],
        ["localhost", "CF_LLM_PROXY_API_DOMAIN must be a lowercase hostname"],
      ] as const)
        assert.include(
          yield* refusal({ ...selfHosted, CF_LLM_PROXY_API_DOMAIN: apiDomain }),
          message,
        );
    }),
  );
});
