import { contextStorage } from "hono/context-storage";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { authMiddleware } from "./middleware/auth";
import { initMiddleware } from "./middleware/init";
import auth from "./routes/auth";
import chat from "./routes/chat";
import sync from "./routes/sync";
import { factory } from "./utils/factory";

const app = factory
  .createApp()
  .use(contextStorage())
  .use(logger())
  .use(initMiddleware())
  .use(authMiddleware())
  .route("/auth", auth)
  .route("/chat", chat)
  .route("/sync", sync)
  .onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status);
    }
    return c.json({ error: "Internal Server Error" }, 500);
  });

export default app;
