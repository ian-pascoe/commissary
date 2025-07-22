import alchemy from "alchemy";
import { D1Database, Vite } from "alchemy/cloudflare";
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
const domain = dev
  ? "localhost:3000"
  : app.stage === "production"
    ? baseDomain
    : `${app.stage}.${baseDomain}`;

const db = await D1Database("db", {
  migrationsDir: "./drizzle",
});

export const webapp = await Vite("webapp", {
  command: "bun run build",
  main: "./src/server/index.ts",
  assets: {
    dist: "./dist",
    html_handling: "auto-trailing-slash",
    not_found_handling: "single-page-application",
  },
  bindings: {
    DB: db,
  },
  dev: {
    command: "bun run dev",
  },
  domains: [domain],
});

console.log({
  "Web App URL": webapp.url,
});

await app.finalize();
