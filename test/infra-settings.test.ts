// The platform admin settings of a deploy (infra/settings.ts): PLATFORM_ADMIN_* and the deprecated ACCESS_ADMIN_*
// names they replace, which a deployment may still set.
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
