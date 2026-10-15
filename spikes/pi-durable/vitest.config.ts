import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/worker.ts",
      miniflare: {
        compatibilityDate: "2026-08-01",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: { AGENT: { className: "AgentDO", useSQLite: true } },
        bindings: { PROXY_URL: "https://proxy.test", PROXY_KEY: "cfp_demo_key_secret" },
      },
    }),
  ],
});
