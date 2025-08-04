import { contextStorage } from "hono/context-storage";
import { HTTPException } from "hono/http-exception";
import * as z from "zod";
import { Config } from "~/schemas/config";
import { authMiddleware } from "./middleware/auth";
import { initMiddleware } from "./middleware/init";
import { loggingMiddleware } from "./middleware/logging";
import auth from "./routes/auth";
import chat from "./routes/chat";
import { factory } from "./utils/factory";

const app = factory
  .createApp()
  .use(contextStorage())
  .use(loggingMiddleware())
  .use(initMiddleware())
  .use(authMiddleware())
  .route("/auth", auth)
  .route("/chat", chat)
  .get("/config.schema.json", (c) => {
    return c.json(z.toJSONSchema(Config));
  })
  .onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status);
    }
    return c.json({ error: "Internal Server Error" }, 500);
  });

export default app;
