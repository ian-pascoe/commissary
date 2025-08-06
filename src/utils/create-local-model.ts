import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  createOpenRouter,
  type LanguageModelV2,
} from "@openrouter/ai-sdk-provider";
import { fetch } from "@tauri-apps/plugin-http";
import { toMerged } from "es-toolkit";
import { config } from "~/lib/config";
import {
  type PreloadedProviderId,
  preloadedProviders,
} from "~/lib/preloaded-providers";
import { strongholdStore } from "~/lib/stronghold";
import type { Config } from "~/schemas/config";
import type { ProviderAuthConfig, ProviderId } from "~/schemas/config/provider";
import type { ProviderOptions } from "~/types/provider-options";
import { AnthropicAuth } from "./auth/anthropic";
import { createId } from "./id";

export const createLocalModel = async (input: {
  modelId: string;
  providersConfig: Config["providers"];
}): Promise<{
  model: LanguageModelV2;
  providerOptions: ProviderOptions;
}> => {
  const [provider, ...modelIdParts] = input.modelId.split(":");
  if (!provider || !modelIdParts.length) {
    throw new Error(`Invalid model ID: ${input.modelId}`);
  }

  let modelId = modelIdParts.join(":");

  let providerConfig = input.providersConfig?.[provider];
  if (!providerConfig) {
    providerConfig = preloadedProviders[provider as PreloadedProviderId];
    if (!providerConfig) {
      throw new Error(`Provider not found in configuration: ${provider}`);
    }
    // Update the provider config to use Commissary's OpenAI-compatible API
    providerConfig = {
      ...providerConfig,
      sdk: "@ai-sdk/openai-compatible",
      auth: {
        type: "api-key",
        apiKey: (await strongholdStore.get("auth-token")) ?? "",
      },
      baseUrl: `${import.meta.env.VITE_API_URL}/openai/v1`,
    };
    modelId = input.modelId; // Use full modelId for preloaded providers
  } else {
    providerConfig = toMerged(
      providerConfig,
      preloadedProviders[provider as PreloadedProviderId] ?? {},
    );
  }

  let model: LanguageModelV2;
  switch (providerConfig.sdk) {
    case "@ai-sdk/anthropic": {
      const headers = {
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-dangerous-direct-browser-access": "true",
        ...providerConfig.headers,
      };
      const anthropic = createAnthropic({
        apiKey:
          providerConfig.auth?.type === "api-key"
            ? await getApiKey({
                provider: provider as ProviderId,
                authConfig: providerConfig.auth,
              })
            : undefined,
        baseURL: providerConfig?.baseUrl,
        headers: {
          ...headers,
          ...(providerConfig.auth?.type === "oauth"
            ? {
                Authorization: `Bearer ${await getAccessToken({
                  provider: provider as ProviderId,
                  authConfig: providerConfig.auth,
                })}`,
              }
            : {}),
        },
        fetch: ((input, init: any) => {
          const headers = init?.headers ?? {};
          if ("Authorization" in headers) {
            delete headers["x-api-key"];
          }
          return fetch(input, {
            ...init,
            headers,
          });
        }) as typeof globalThis.fetch,
      });
      model = anthropic(modelId);
      (model as any).needsAnthropicSpoof = true; // Add a flag to indicate we need to spoof the user-agent
      break;
    }
    case "@ai-sdk/google": {
      const google = createGoogleGenerativeAI({
        apiKey: await getApiKey({
          provider,
          authConfig: providerConfig.auth,
        }),
        baseURL: providerConfig.baseUrl,
        headers: providerConfig.headers,
        fetch: fetch as typeof globalThis.fetch,
      });
      model = google(modelId);
      break;
    }
    case "@ai-sdk/groq": {
      const groq = createGroq({
        apiKey: await getApiKey({
          provider,
          authConfig: providerConfig.auth,
        }),
        baseURL: providerConfig.baseUrl,
        headers: providerConfig.headers,
        fetch: fetch as typeof globalThis.fetch,
      });
      model = groq(modelId);
      break;
    }
    case "@ai-sdk/openai": {
      const openai = createOpenAI({
        apiKey: await getApiKey({
          provider,
          authConfig: providerConfig.auth,
        }),
        baseURL: providerConfig.baseUrl,
        headers: providerConfig.headers,
        fetch: fetch as typeof globalThis.fetch,
      });
      model = openai(modelId);
      break;
    }
    case "@ai-sdk/openai-compatible": {
      const baseUrl = providerConfig?.baseUrl;
      if (!baseUrl) {
        throw new Error(
          `Missing baseUrl for OpenAI-compatible provider: ${provider}`,
        );
      }
      const openaiCompat = createOpenAICompatible({
        name: providerConfig.name || provider,
        apiKey:
          providerConfig.auth?.type === "api-key"
            ? await getApiKey({
                provider,
                authConfig: providerConfig.auth,
              })
            : undefined,
        baseURL: baseUrl,
        headers: providerConfig.headers,
        fetch: fetch as typeof globalThis.fetch,
      });
      model = openaiCompat(modelId);
      break;
    }
    case "@openrouter/ai-sdk-provider": {
      const openRouter = createOpenRouter({
        apiKey: await getApiKey({
          provider,
          authConfig: providerConfig.auth,
        }),
        baseURL: providerConfig.baseUrl,
        headers: providerConfig.headers,
        fetch: fetch as typeof globalThis.fetch,
      });
      model = openRouter(modelId);
      break;
    }
    default: {
      throw new Error(`Unsupported provider SDK: ${providerConfig.sdk}`);
    }
  }

  return {
    model,
    providerOptions: {
      [model.provider]: {
        ...providerConfig.options,
        ...providerConfig.models?.[modelId]?.options,
      },
    },
  };
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
    const strongholdId = apiKey.slice(3, -1);
    const storedKey = await strongholdStore.get(strongholdId);
    if (!storedKey || typeof storedKey !== "string") {
      throw new Error(
        `API key not found in stronghold for provider ${provider}; id: ${strongholdId}`,
      );
    }
    apiKey = storedKey;
  } else {
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
    const strongholdId = accessToken.slice(3, -1);
    const storedToken = await strongholdStore.get(strongholdId);
    if (!storedToken || typeof storedToken !== "string") {
      throw new Error(
        `Access token not found in stronghold for provider ${provider}; id: ${strongholdId}`,
      );
    }
    accessToken = storedToken;
  } else {
    accessToken = authConfig.accessToken;
  }
  return accessToken;
};
