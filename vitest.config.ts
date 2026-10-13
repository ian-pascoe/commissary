import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The test Worker mirrors the deployed one declared in alchemy.run.ts (same entry, compatibility settings and binding
// names); there is no Wrangler configuration file.
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      miniflare: {
        compatibilityDate: "2026-08-01",
        compatibilityFlags: ["nodejs_compat"],
        // Same module types as the deployed bundle (alchemy.run.ts): tokenizer ranks are `Data` modules (ArrayBuffer).
        modulesRules: [{ type: "Data", include: ["**/*.bin"] }],
        durableObjects: {
          CONTROL_PLANE: { className: "ControlPlane", useSQLite: true },
          SESSION_STATE: { className: "SessionState", useSQLite: true },
          PLATFORM: { className: "Platform", useSQLite: true },
        },
        kvNamespaces: ["CACHE"],
        d1Databases: ["USAGE"],
        assets: {
          directory: "./public",
          binding: "ASSETS",
          routerConfig: { invoke_user_worker_ahead_of_assets: true },
        },
        bindings: {
          ACCESS_TEAM_DOMAIN: "",
          ACCESS_AUD: "",
          PLATFORM_ADMIN_EMAILS: "",
          PLATFORM_ADMIN_SERVICE_TOKENS: "",
          // End-to-end tests through `exports.default.fetch` authenticate with the dev bypass, which only applies to
          // loopback hosts (`http://localhost/...`) while ACCESS_TEAM_DOMAIN/ACCESS_AUD stay empty; other hosts still
          // fail closed (`https://proxy.test/...` answers 500 without Access settings).
          ACCESS_DEV_BYPASS: "true",
          USAGE_RETENTION_DAYS: "30",
          META_MINT_URL: "",
          // Fixed test key of the keyed `auth_index` (deployed: an Alchemy `Random`, alchemy.run.ts); 64 characters, so
          // tests that configure Access (where shorter keys are refused, src/management/auth-index.ts) can use it too.
          AUTH_INDEX_KEY: "cf-llm-proxy-test-auth-index-key-0123456789abcdef0123456789abcdef012",
          // Fixed test secrets keys (deployed: an Alchemy `Random`, alchemy.run.ts), 64 characters like the minted ones. The
          // previous key lets tests start a ControlPlane whose data key is still wrapped by it (a rotation, src/secrets/).
          SECRETS_KEY: "cf-llm-proxy-test-secrets-key-0123456789abcdef0123456789abcdef0123",
          SECRETS_KEY_PREVIOUS: "cf-llm-proxy-test-previous-secrets-key-0123456789abcdef0123456789",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    // The first test in each file pays for module transformation inside workerd; keep generous timeouts.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
