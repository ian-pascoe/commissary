import * as z from "zod";
import type { ProviderConfig } from "~/schemas/config/provider";

export const preloadedProviderIds = [
  "anthropic",
  "deepseek",
  "google",
  "groq",
  "openai",
  "openrouter",
  "togetherai",
] as const;
export const PreloadedProviderId = z.enum(preloadedProviderIds);
export type PreloadedProviderId = z.infer<typeof PreloadedProviderId>;

export const preloadedProviders: Record<PreloadedProviderId, ProviderConfig> = {
  anthropic: {
    name: "Anthropic",
    sdk: "@ai-sdk/anthropic",
  },
  deepseek: {
    name: "DeepSeek",
    sdk: "@ai-sdk/deepseek",
  },
  google: {
    name: "Google Generative AI",
    sdk: "@ai-sdk/google",
  },
  groq: {
    name: "Groq",
    sdk: "@ai-sdk/groq",
  },
  openai: {
    name: "OpenAI",
    sdk: "@ai-sdk/openai",
  },
  openrouter: {
    name: "OpenRouter",
    sdk: "@openrouter/ai-sdk-provider",
  },
  togetherai: {
    name: "Together.ai",
    sdk: "@ai-sdk/togetherai",
  },
};
