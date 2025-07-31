import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { fetch } from "@tauri-apps/plugin-http";
import type { LanguageModel } from "ai";
import { config } from "~/lib/config";
import { strongholdStore } from "~/lib/stronghold";
import type { Config } from "~/schemas/config";
import type { ProviderAuthConfig, ProviderId } from "~/schemas/config/provider";
import { AnthropicAuth } from "./auth/anthropic";
import { createId } from "./id";

export const constructLocalModel = async (input: {
  modelId: string;
  providers: Config["providers"];
}) => {
  const startTime = performance.now();
  console.log(
    `[Performance] Starting model construction for: ${input.modelId}`,
  );

  const [provider, modelId] = input.modelId.split(":");
  if (!provider || !modelId) {
    throw new Error(`Invalid model ID: ${input.modelId}`);
  }
  if (!(provider in (input.providers ?? {}))) {
    throw new Error(`Provider not configured: ${provider}`);
  }

  const providerConfig =
    input.providers?.[provider as keyof typeof input.providers];
  if (!providerConfig) {
    throw new Error(`Provider configuration missing for: ${provider}`);
  }

  let model: LanguageModel;
  switch (providerConfig.sdk) {
    case "@ai-sdk/anthropic": {
      const authType = providerConfig.auth?.type;
      if (!authType) {
        throw new Error(
          `Missing auth configuration for Anthropic provider: ${provider}`,
        );
      }
      const modelInitStart = performance.now();
      const defaultHeaders = {
        "anthropic-dangerous-direct-browser-access": "true",
      };
      const anthropic = createAnthropic({
        fetch: fetch as typeof globalThis.fetch,
        headers:
          authType === "oauth"
            ? {
                ...defaultHeaders,
                Authorization: `Bearer ${await getAccessToken({
                  provider: provider as ProviderId,
                  authConfig: providerConfig.auth,
                })}`,
              }
            : defaultHeaders,
        apiKey:
          authType === "api-key"
            ? await getApiKey({
                provider: provider as ProviderId,
                authConfig: providerConfig.auth,
              })
            : undefined,
      });
      model = anthropic(modelId);
      const modelInitTime = performance.now() - modelInitStart;
      console.log(
        `[Performance] Anthropic model initialization took ${modelInitTime.toFixed(2)}ms`,
      );
      break;
    }
    case "@ai-sdk/google": {
      const modelInitStart = performance.now();
      const google = createGoogleGenerativeAI({
        fetch: fetch as typeof globalThis.fetch,
        apiKey: await getApiKey({
          provider,
          authConfig: providerConfig.auth,
        }),
      });
      model = google(modelId);
      const modelInitTime = performance.now() - modelInitStart;
      console.log(
        `[Performance] Google model initialization took ${modelInitTime.toFixed(2)}ms`,
      );
      break;
    }
    case "@ai-sdk/openai": {
      const modelInitStart = performance.now();
      const openai = createOpenAI({
        fetch: fetch as typeof globalThis.fetch,
        apiKey: await getApiKey({
          provider,
          authConfig: providerConfig.auth,
        }),
      });
      model = openai(modelId);
      const modelInitTime = performance.now() - modelInitStart;
      console.log(
        `[Performance] OpenAI model initialization took ${modelInitTime.toFixed(2)}ms`,
      );
      break;
    }
    case "@ai-sdk/openai-compatible": {
      const modelInitStart = performance.now();
      const authType = providerConfig.auth?.type;
      const baseUrl = providerConfig?.baseUrl;
      if (!baseUrl) {
        throw new Error(
          `Missing baseUrl for OpenAI-compatible provider: ${provider}`,
        );
      }
      const openaiCompat = createOpenAICompatible({
        fetch: fetch as typeof globalThis.fetch,
        name: providerConfig.name || provider,
        apiKey:
          authType === "api-key"
            ? await getApiKey({
                provider,
                authConfig: providerConfig.auth,
              })
            : undefined,
        baseURL: baseUrl,
      });
      model = openaiCompat(modelId);
      const modelInitTime = performance.now() - modelInitStart;
      console.log(
        `[Performance] OpenAI-compatible model initialization took ${modelInitTime.toFixed(2)}ms`,
      );
      break;
    }
    default: {
      throw new Error(`Unsupported provider SDK: ${providerConfig.sdk}`);
    }
  }

  const totalTime = performance.now() - startTime;
  console.log(
    `[Performance] Model construction completed in ${totalTime.toFixed(2)}ms for ${input.modelId}`,
  );

  return model;
};

export const getApiKey = async ({
  provider,
  authConfig,
}: {
  provider: string;
  authConfig: ProviderAuthConfig | undefined;
}) => {
  if (!authConfig) {
    throw new Error("Missing auth configuration");
  }
  if (authConfig.type !== "api-key") {
    throw new Error(`Unsupported auth type: ${authConfig.type}`);
  }

  let apiKey = authConfig.apiKey;
  if (apiKey.startsWith("sh(") && apiKey.endsWith(")")) {
    const strongholdStart = performance.now();
    const strongholdId = apiKey.slice(3, -1);
    const storedKey = await strongholdStore.get(strongholdId);
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
    console.log("[Performance] Using direct API key for provider:", provider);
    apiKey = authConfig.apiKey;
  }
  return apiKey;
};

export const getAccessToken = async ({
  provider,
  authConfig,
}: {
  provider: ProviderId;
  authConfig: ProviderAuthConfig | undefined;
}) => {
  if (!authConfig) {
    throw new Error("Missing auth configuration");
  }
  if (authConfig.type !== "oauth") {
    throw new Error(`Unsupported auth type: ${authConfig.type}`);
  }
  let accessToken = authConfig.accessToken;
  let refreshToken = authConfig.refreshToken;
  if (authConfig.expiresAt < Date.now()) {
    if (provider === "anthropic") {
      const newTokens = await AnthropicAuth.refresh(refreshToken);
      accessToken = newTokens.accessToken;
      refreshToken = newTokens.refreshToken;

      const accessTokenStrongholdId = createId();
      const refreshTokenStrongholdId = createId();
      Promise.all([
        strongholdStore.set(accessTokenStrongholdId, newTokens.accessToken),
        strongholdStore.set(refreshTokenStrongholdId, newTokens.refreshToken),
      ]).then(() =>
        config.merge({
          providers: {
            [provider]: {
              auth: {
                type: "oauth",
                accessToken: `sh(${accessTokenStrongholdId})`,
                refreshToken: `sh(${refreshTokenStrongholdId})`,
                expiresAt: newTokens.expiresAt,
              },
            },
          },
        }),
      );
    } else {
      throw new Error(
        `Token expired and refresh not implemented for provider: ${provider}`,
      );
    }
  }

  if (accessToken.startsWith("sh(") && accessToken.endsWith(")")) {
    const strongholdStart = performance.now();
    const strongholdId = accessToken.slice(3, -1);
    const storedToken = await strongholdStore.get(strongholdId);
    const strongholdTime = performance.now() - strongholdStart;
    console.log(
      `[Performance] Retrieved access token from stronghold in ${strongholdTime.toFixed(2)}ms:`,
      strongholdId,
      storedToken ? "[REDACTED]" : "null",
    );
    if (!storedToken || typeof storedToken !== "string") {
      throw new Error(
        `Access token not found in stronghold for provider ${provider}; id: ${strongholdId}`,
      );
    }
    accessToken = storedToken;
  } else {
    console.log(
      "[Performance] Using direct access token for provider:",
      provider,
    );
    accessToken = authConfig.accessToken;
  }
  return accessToken;
};
