import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { StrongholdStore } from "~/lib/stronghold";
import type { Config } from "~/schemas/config";

export const constructLocalModel = async (input: {
  modelId: string;
  providers: NonNullable<Config["providers"]>;
  strongholdStore: StrongholdStore;
}) => {
  const startTime = performance.now();
  console.log(
    `[Performance] Starting model construction for: ${input.modelId}`,
  );

  const [provider, modelId] = input.modelId.split(":");
  if (!provider || !modelId) {
    throw new Error(`Invalid model ID: ${input.modelId}`);
  }
  if (!(provider in input.providers)) {
    throw new Error(`Provider not configured: ${provider}`);
  }

  let model: LanguageModel;
  switch (provider) {
    case "google": {
      const auth = input.providers.google?.auth;
      if (!auth) {
        throw new Error(`Provider not configured: ${provider}`);
      }
      if (auth.type !== "api-key") {
        throw new Error(
          `Unsupported auth type for Google Generative AI: ${auth.type}`,
        );
      }
      let apiKey = auth.apiKey;
      if (apiKey.startsWith("sh(") && apiKey.endsWith(")")) {
        const strongholdStart = performance.now();
        const strongholdId = apiKey.slice(3, -1);
        const storedKey = await input.strongholdStore.get(strongholdId);
        const strongholdTime = performance.now() - strongholdStart;
        console.log(
          `[Performance] Retrieved API key from stronghold in ${strongholdTime.toFixed(2)}ms:`,
          strongholdId,
          storedKey ? "[REDACTED]" : "null",
        );
        if (!storedKey || typeof storedKey !== "string") {
          throw new Error(
            `API key not found in stronghold for provider ${provider}; id: ${strongholdId}`,
          );
        }
        apiKey = storedKey;
      } else {
        console.log(
          "[Performance] Using direct API key for provider:",
          provider,
        );
        apiKey = auth.apiKey;
      }

      const modelInitStart = performance.now();
      const google = createGoogleGenerativeAI({
        apiKey,
      });
      model = google(modelId);
      const modelInitTime = performance.now() - modelInitStart;
      console.log(
        `[Performance] Google model initialization took ${modelInitTime.toFixed(2)}ms`,
      );
      break;
    }
    case "openai": {
      const auth = input.providers.openai?.auth;
      if (!auth) {
        throw new Error(`Provider not configured: ${provider}`);
      }
      if (auth.type !== "api-key") {
        throw new Error(
          `Unsupported auth type for Google Generative AI: ${auth.type}`,
        );
      }
      let apiKey = auth.apiKey;
      if (apiKey.startsWith("sh(") && apiKey.endsWith(")")) {
        const strongholdStart = performance.now();
        const strongholdId = apiKey.slice(3, -1);
        const storedKey = await input.strongholdStore.get(strongholdId);
        const strongholdTime = performance.now() - strongholdStart;
        console.log(
          `[Performance] Retrieved API key from stronghold in ${strongholdTime.toFixed(2)}ms:`,
          strongholdId,
          storedKey ? "[REDACTED]" : "null",
        );
        if (!storedKey || typeof storedKey !== "string") {
          throw new Error(
            `API key not found in stronghold for provider ${provider}; id: ${strongholdId}`,
          );
        }
        apiKey = storedKey;
      } else {
        console.log(
          "[Performance] Using direct API key for provider:",
          provider,
        );
        apiKey = auth.apiKey;
      }

      const modelInitStart = performance.now();
      const openai = createOpenAI({
        apiKey,
      });
      model = openai(modelId);
      const modelInitTime = performance.now() - modelInitStart;
      console.log(
        `[Performance] OpenAI model initialization took ${modelInitTime.toFixed(2)}ms`,
      );
      break;
    }
    default: {
      throw new Error(`Unsupported provider: ${provider}`);
    }
  }

  const totalTime = performance.now() - startTime;
  console.log(
    `[Performance] Model construction completed in ${totalTime.toFixed(2)}ms for ${input.modelId}`,
  );

  return model;
};
