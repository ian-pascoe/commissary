import Database from "@tauri-apps/plugin-sql";
import { drizzle, type SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import * as schema from "~/drizzle/local/schema";
import { createBatchProxy, createProxy } from "./proxy";

const cachedDb: SqliteRemoteDatabase<typeof schema> | null = null;

export const initDb = async () => {
  const sqlite = await Database.load("sqlite:sqlite.db");
  let db: SqliteRemoteDatabase<typeof schema> | null = cachedDb;
  if (!db) {
    db = drizzle<typeof schema>(createProxy(sqlite), createBatchProxy(sqlite), {
      schema,
    });
  }
  return db;
};
