import alchemy from "alchemy";
import { D1Database, KVNamespace, Worker } from "alchemy/cloudflare";
import { CloudflareStateStore } from "alchemy/state";

const project = "commissary";
const baseDomain = "commissary.dev";

const app = await alchemy(project, {
  password: process.env.ALCHEMY_PASSWORD,
  stateStore: (scope) =>
    new CloudflareStateStore(scope, {
      stateToken: alchemy.secret(process.env.ALCHEMY_STATE_TOKEN),
    }),
});

const dev = app.local;
const domain =
  app.stage === "production"
    ? baseDomain
    : app.stage === "development"
      ? `dev.${baseDomain}`
      : `${app.stage}.dev.${baseDomain}`;

const db = await D1Database("db", {
  migrationsDir: "./drizzle/remote/migrations",
});

const authKv = await KVNamespace("auth-kv", {});

const kv = await KVNamespace("kv", {});

const apiDomain = `api.${domain}`;
const apiUrl = dev ? "http://localhost:8080" : `https://${apiDomain}`;
const appDomain = `app.${domain}`;
const appUrl = dev ? "http://localhost:3000" : `https://${appDomain}`;

export const api = await Worker("api", {
  entrypoint: "./src/server/index.ts",
  compatibilityFlags: ["nodejs_compat"],
  bindings: {
    DB: db,
    AUTH_KV: authKv,
    KV: kv,
    DOMAIN: domain,
    API_URL: apiUrl,
    APP_URL: appUrl,
    GOOGLE_API_KEY: alchemy.secret(process.env.GOOGLE_API_KEY),
  },
  dev: {
    port: 8080,
  },
  domains: [apiDomain],
});

if (dev) {
  Bun.spawn({
    cmd: ["tauri", "dev"],
    env: {
      ...process.env,
      VITE_API_URL: apiUrl,
      VITE_APP_URL: appUrl,
    },
  });
}

console.log({
  "API URL": apiUrl,
});

await app.finalize();
