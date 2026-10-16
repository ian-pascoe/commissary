import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { BUNDLE_ALIASES } from "../../infra/bundle.ts";

/** Bindings of a self-hosted Commissary (`COMMISSARY_MODE` unset), the deployment every test but `test/hosted/` runs against. */
const SELF_HOSTED_BINDINGS = {
  ACCESS_TEAM_DOMAIN: "",
  ACCESS_AUD: "",
  PLATFORM_ADMIN_EMAILS: "",
  PLATFORM_ADMIN_SERVICE_TOKENS: "",
  // End-to-end tests through `exports.default.fetch` authenticate with the dev bypass, which only applies to
  // loopback hosts (`http://localhost/...`) while ACCESS_TEAM_DOMAIN/ACCESS_AUD stay empty; other hosts still
  // fail closed (`https://commissary.test/...` answers 500 without Access settings).
  ACCESS_DEV_BYPASS: "true",
  META_MINT_URL: "",
  // Fixed test key of the keyed `auth_index` (deployed: an Alchemy `Random`, alchemy.run.ts); 64 characters, so
  // tests that configure Access (where shorter keys are refused, src/management/auth-index.ts) can use it too.
  AUTH_INDEX_KEY: "commissary-test-auth-index-key-0123456789abcdef0123456789abcdef01234",
  // Fixed test secrets keys (deployed: an Alchemy `Random`, alchemy.run.ts), 64 characters like the minted ones. The
  // previous key lets tests start a ControlPlane whose data key is still wrapped by it (a rotation, src/secrets/).
  SECRETS_KEY: "commissary-test-secrets-key-0123456789abcdef0123456789abcdef012345",
  SECRETS_KEY_PREVIOUS: "commissary-test-previous-secrets-key-0123456789abcdef012345678901",
};

/**
 * Commissary Cloud (`COMMISSARY_MODE=cloud`, ADR 0026, `src/hosted/`): Better Auth signs people in with GitHub and Google (stubbed through the
 * global `fetch` in the tests), Turnstile guards sign-up, and the per-org rate limit is low enough to reach. No dev
 * bypass: requests go to `https://commissary.test`.
 */
const HOSTED_BINDINGS = {
  ...SELF_HOSTED_BINDINGS,
  ACCESS_DEV_BYPASS: "",
  COMMISSARY_MODE: "cloud",
  PLATFORM_ADMIN_EMAILS: "root@example.com",
  PLATFORM_ADMIN_SERVICE_TOKENS: "admin-token.access",
  BETTER_AUTH_SECRET: "commissary-test-better-auth-secret-0123456789abcdef0123456789abcd",
  SIGN_IN_GITHUB_CLIENT_ID: "github-client-id",
  SIGN_IN_GITHUB_CLIENT_SECRET: "github-client-secret",
  SIGN_IN_GOOGLE_CLIENT_ID: "google-client-id",
  SIGN_IN_GOOGLE_CLIENT_SECRET: "google-client-secret",
  TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
  TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
  OWNED_ORG_LIMIT: "3",
};

/** Requests per minute an org may send on the client API of the Commissary Cloud test Worker (test/hosted/rate-limit.test.ts). */
const HOSTED_TEST_RATE_LIMIT = 5;

// The test Worker mirrors the deployed one declared in alchemy.run.ts (same handler and Durable Object classes,
// compatibility settings and binding names); there is no Wrangler configuration file. Its entry, test/worker.ts,
// re-exports src/index.ts and adds the Durable Object classes only tests use (`GETTER_PROBE`).
const worker = (bindings: Record<string, string>, hosted: boolean) =>
  cloudflareTest({
    main: "./test/worker.ts",
    miniflare: {
      compatibilityDate: "2026-08-01",
      compatibilityFlags: ["nodejs_compat"],
      // Same module types as the deployed bundle (alchemy.run.ts): tokenizer ranks are `Data` modules (ArrayBuffer).
      modulesRules: [{ type: "Data", include: ["**/*.bin"] }],
      durableObjects: {
        CONTROL_PLANE: { className: "ControlPlane", useSQLite: true },
        SESSION_STATE: { className: "SessionState", useSQLite: true },
        PLATFORM: { className: "Platform", useSQLite: true },
        // Test-only (test/support/getter-probe.ts): an area part behind a getter, test/getter-pipelining.test.ts.
        GETTER_PROBE: { className: "GetterProbe", useSQLite: true },
      },
      kvNamespaces: ["CACHE"],
      d1Databases: ["USAGE"],
      ...(hosted
        ? {
            ratelimits: {
              ORG_RATE_LIMIT: {
                namespace_id: "1001",
                simple: { limit: HOSTED_TEST_RATE_LIMIT, period: 60 as const },
              },
            },
          }
        : {}),
      assets: {
        // The control panel's build (`pnpm build`), as deployed. No test reads it (a missing folder serves nothing): the
        // tests that need a panel bind their own `ASSETS`, so it is not an input of the test task (turbo.json).
        directory: "../web/dist",
        binding: "ASSETS",
        routerConfig: { invoke_user_worker_ahead_of_assets: true },
      },
      bindings,
    },
  });

export default defineConfig({
  resolve: { alias: { ...BUNDLE_ALIASES } },
  test: {
    // The first test in each file pays for module transformation inside workerd; keep generous timeouts.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // The tests and the Durable Objects share one isolate here, so an error thrown across Durable Object RPC is also
    // reported as an unhandled rejection of the object's side, after the caller handled it. Only the errors
    // test/getter-pipelining.test.ts provokes on purpose are ignored; the others still fail the run.
    onUnhandledError: (error) =>
      !(
        error.message.includes("[getter-probe]") ||
        error.message.includes('the method "pipelinedThroughGetter"')
      ),
    projects: [
      {
        extends: true,
        plugins: [worker(SELF_HOSTED_BINDINGS, false)],
        test: {
          name: "self-hosted",
          include: ["test/**/*.test.ts"],
          exclude: ["test/hosted/**"],
        },
      },
      {
        extends: true,
        plugins: [worker(HOSTED_BINDINGS, true)],
        // Each file's `installFakes` loads Better Auth once (slow under a full parallel run), outside the tests.
        test: { name: "hosted", include: ["test/hosted/**/*.test.ts"], hookTimeout: 120_000 },
      },
    ],
  },
});
