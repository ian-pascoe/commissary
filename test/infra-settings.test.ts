// Deploy settings (infra/settings.ts): the platform admins (PLATFORM_ADMIN_* and the deprecated ACCESS_ADMIN_* names
// they replace, which a deployment may still set) and the secrets key generations.
import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Logger } from "effect";
import { readSettings } from "../infra/settings.ts";

const read = (variables: Record<string, string>) => {
  const warnings: Array<string> = [];

  const capture = Logger.layer([
    Logger.make(({ logLevel, message }) => {
      if (logLevel === "Warn") warnings.push([message].flat().map(String).join(" "));
    }),
  ]);

  return readSettings(true, "dev").pipe(
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
