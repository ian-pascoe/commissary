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
  name: `${project}-${app.stage}-db`,
  migrationsDir: "./drizzle/remote/migrations",
});

const kv = await KVNamespace("kv", {
  title: `${project}-${app.stage}-kv`,
});

const apiDomain = `api.${domain}`;
const apiUrl = dev ? "http://localhost:8080" : `https://${apiDomain}`;
const appDomain = `app.${domain}`;
const appUrl = dev ? "http://localhost:3000" : `https://${appDomain}`;

export const api = await Worker("api", {
  entrypoint: "./src/server/index.ts",
  compatibilityFlags: ["nodejs_compat"],
  bindings: {
    NODE_ENV: app.stage === "production" ? "production" : "development",
    DB: db,
    KV: kv,
    DOMAIN: domain,
    API_URL: apiUrl,
    APP_URL: appUrl,
    BETTER_AUTH_SECRET: alchemy.secret(process.env.BETTER_AUTH_SECRET),
    ANTHROPIC_API_KEY: alchemy.secret(process.env.ANTHROPIC_API_KEY),
    GOOGLE_API_KEY: alchemy.secret(process.env.GOOGLE_API_KEY),
    GROQ_API_KEY: alchemy.secret(process.env.GROQ_API_KEY),
    OPENAI_API_KEY: alchemy.secret(process.env.OPENAI_API_KEY),
    OPENROUTER_API_KEY: alchemy.secret(process.env.OPENROUTER_API_KEY),
  },
  dev: {
    port: 8080,
  },
  domains: [apiDomain],
});

console.log({
  "API URL": apiUrl,
});

await app.finalize();
