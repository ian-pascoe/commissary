import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./drizzle/remote/schema.ts",
  out: "./drizzle/remote/migrations",
  dialect: "sqlite",
  dbCredentials: {
    url: ".alchemy/miniflare/d1/miniflare-D1DatabaseObject/4fea589dffe569f8ba071ec87ac0160124823fb6b357717ae164e87fbe3b243a.sqlite",
  },
});
