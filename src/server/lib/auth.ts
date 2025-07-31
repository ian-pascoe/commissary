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
    secret: env.BETTER_AUTH_SECRET,
    baseURL: `${env.API_URL}/auth`,
    trustedOrigins: [env.APP_URL],
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema,
      usePlural: true,
    }),
    secondaryStorage: {
      get: async (key) => {
        return await cache.get(`auth:${key}`);
      },
      set: async (key, value, ttl) => {
        await cache.put(`auth:${key}`, value, {
          expirationTtl: ttl ? ttl * 1000 : undefined,
        });
      },
      delete: async (key) => {
        await cache.delete(`auth:${key}`);
      },
    },
    logger: {
      disabled: false,
      level: env.NODE_ENV === "production" ? "error" : "debug",
      log: (level, message, ...args) => {
        console[level](`[Auth] ${message}`, ...args);
      },
    },
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
    },
    advanced: {
      database: {
        generateId: false,
      },
      crossSubDomainCookies: {
        enabled: true,
      },
    },
    plugins: [
      anonymous({
        emailDomainName: "commissary.dev",
      }),
      bearer(),
    ],
  });
};

export const auth = (ctx = c()) => ctx.get("auth");
