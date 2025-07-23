import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./drizzle/remote/schema.ts",
  out: "./drizzle/remote/migrations",
  dialect: "sqlite",
  driver: "d1-http",
});
