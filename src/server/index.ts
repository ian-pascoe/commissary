import { contextStorage } from "hono/context-storage";
import { HTTPException } from "hono/http-exception";
import * as z from "zod";
import { Config } from "~/schemas/config";
import { providerRegistry } from "./lib/provider-registry";
import { authMiddleware, requireAuthMiddleware } from "./middleware/auth";
import { initMiddleware } from "./middleware/init";
import { loggingMiddleware } from "./middleware/logging";
import auth from "./routes/auth";
import { factory } from "./utils/factory";
import { createOpenAICompat } from "./utils/openai-compat";

const app = factory
  .createApp()
  .use(contextStorage())
  .use(loggingMiddleware())
  .use(initMiddleware())
  .use(authMiddleware())
  .get("/config.schema.json", (c) => {
    return c.json(z.toJSONSchema(Config));
  })
  .route("/auth", auth)
  .route(
    "/",
    createOpenAICompat({
      middleware: requireAuthMiddleware(),
      languageModels: (modelId) =>
        providerRegistry().languageModel(modelId as any),
      embeddingModels: (modelId) =>
        providerRegistry().textEmbeddingModel(modelId as any),
      speechModels: (modelId) => providerRegistry().speechModel(modelId as any),
      imageModels: (modelId) => providerRegistry().imageModel(modelId as any),
    }),
  )
  .onError((err, c) => {
    console.error("[Error] ", err);
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status);
    }
    return c.json({ error: "Internal Server Error" }, 500);
  });

export default app;
