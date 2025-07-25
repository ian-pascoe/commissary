import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./drizzle/local/schema.ts",
  out: "./src-tauri/migrations",
  dialect: "sqlite",
  dbCredentials: {
    url: `file://${process.env.HOME}/Library/Application\ Support/com.spiritledsoftware.commissary/sqlite.db`,
  },
});
