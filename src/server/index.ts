import { contextStorage } from "hono/context-storage";
import { logger } from "hono/logger";
import { initAuthClient } from "./lib/auth/client";
import { initCache } from "./lib/cache";
import { initDb } from "./lib/db";
import auth from "./routes/auth";
import chat from "./routes/chat";
import { factory } from "./utils/factory";

const app = factory
  .createApp()
  .use(contextStorage())
  .use(logger())
  .use((c, next) => {
    c.set("db", initDb(c));
    c.set("cache", initCache(c));
    c.set("authClient", initAuthClient(c));
    return next();
  })
  .route("/auth", auth)
  .route("/chat", chat);

export default app;
