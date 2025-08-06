import { initAuth } from "../lib/auth";
import { initCache } from "../lib/cache";
import { initDb } from "../lib/db";
import { initProviders } from "../lib/providers";
import { env } from "../utils/env";
import { factory } from "../utils/factory";

export const initMiddleware = () => {
  return factory.createMiddleware((c, next) => {
    const db = initDb(c);
    c.set("db", db);

    const cache = initCache(c);
    c.set("cache", cache);

    c.set("auth", initAuth(db, cache, env(c)));

    c.set("providers", initProviders(c));

    return next();
  });
};
