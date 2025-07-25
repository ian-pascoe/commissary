import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { anonymous, bearer } from "better-auth/plugins";
import * as schema from "~~/drizzle/remote/schema";
import type { Bindings } from "../types/hono";
import { c } from "../utils/context";
import type { Cache } from "./cache";
import type { Database } from "./db";

export const initAuth = (db: Database, cache: Cache, env: Bindings) => {
  return betterAuth({
    baseURL: `${env.API_URL}/auth`,
    trustedOrigins: [env.APP_URL],
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema,
      usePlural: true,
    }),
    secondaryStorage: {
      get: (key) => cache.get(key),
      set: (key, value, ttl) => cache.put(key, value, { expirationTtl: ttl }),
      delete: (key) => cache.delete(key),
    },
    plugins: [anonymous(), bearer()],
  });
};

export const auth = (ctx = c()) => ctx.get("auth");
