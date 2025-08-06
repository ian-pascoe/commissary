import { contextStorage } from "hono/context-storage";
import { HTTPException } from "hono/http-exception";
import * as z from "zod";
import { Config } from "~/schemas/config";
import { providers } from "./lib/providers";
import { authMiddleware, requireAuthMiddleware } from "./middleware/auth";
import { initMiddleware } from "./middleware/init";
import { loggingMiddleware } from "./middleware/logging";
import auth from "./routes/auth";
import { createOpenAICompat } from "./routes/openai";
import { factory } from "./utils/factory";

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
    "/openai",
    createOpenAICompat({
      middleware: requireAuthMiddleware(),
      languageModels: (modelId) =>
        providers().registry.languageModel(modelId as any),
      embeddingModels: (modelId) =>
        providers().registry.textEmbeddingModel(modelId as any),
      speechModels: (modelId) =>
        providers().registry.speechModel(modelId as any),
      transcriptionModels: (modelId) =>
        providers().registry.transcriptionModel(modelId as any),
      imageModels: (modelId) => providers().registry.imageModel(modelId as any),
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
