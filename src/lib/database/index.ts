import SQL from "@tauri-apps/plugin-sql";
import { drizzle, type SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import * as schema from "~~/drizzle/local/schema";
import { migrate } from "./migrate";
import { createBatchProxy, createProxy } from "./proxy";

let cachedDb: SqliteRemoteDatabase<typeof schema> | null = null;

export const initLocalDb = async () => {
  if (cachedDb) {
    return cachedDb;
  }

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
  cachedDb = db;

  console.log("Local database initialized successfully");
  return cachedDb;
};

export type LocalDatabase = Awaited<ReturnType<typeof initLocalDb>>;
