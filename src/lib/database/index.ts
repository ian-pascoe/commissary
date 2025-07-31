import SQL from "@tauri-apps/plugin-sql";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import * as schema from "~~/drizzle/local/schema";
import { migrate } from "./migrate";
import { createBatchProxy, createProxy } from "./proxy";

const initLocalDb = async () => {
  console.log("Initializing local database...");

  const sqlite = await SQL.load("sqlite:sqlite.db");
  const db = drizzle<typeof schema>(
    createProxy(sqlite),
    createBatchProxy(sqlite),
    {
      schema,
    },
  );
  await migrate(sqlite);

  console.log("Local database initialized successfully");
  return db;
};
export type LocalDatabase = Awaited<ReturnType<typeof initLocalDb>>;

export const localDb = await initLocalDb();
