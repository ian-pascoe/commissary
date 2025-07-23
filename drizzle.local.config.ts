import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./drizzle/local/schema.ts",
  out: "./src-tauri/migrations",
  dialect: "sqlite",
});
