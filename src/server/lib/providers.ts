import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import type { ProviderV2 } from "@ai-sdk/provider";
import { createTogetherAI } from "@ai-sdk/togetherai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createProviderRegistry } from "ai";
import type { Context } from "hono";
import type { Env } from "../types/hono";
import { c } from "../utils/context";
import { env } from "../utils/env";

export const initProviders = (c: Context<Env>) => {
  const providers = {
    anthropic: createAnthropic({
      apiKey: env(c).ANTHROPIC_API_KEY,
    }),
    deepseek: createDeepSeek({
      apiKey: env(c).DEEPSEEK_API_KEY,
    }),
    google: createGoogleGenerativeAI({
      apiKey: env(c).GOOGLE_API_KEY,
    }),
    groq: createGroq({
      apiKey: env(c).GROQ_API_KEY,
    }),
    openai: createOpenAI({
      apiKey: env(c).OPENAI_API_KEY,
    }),
    // @ts-expect-error - OpenRouter issues
    openrouter: createOpenRouter({
      apiKey: env(c).OPENROUTER_API_KEY,
    }),
    togetherai: createTogetherAI({
      apiKey: env(c).TOGETHERAI_API_KEY,
    }),
  } as const satisfies Record<string, ProviderV2>;

  return {
    // @ts-expect-error - OpenRouter issues
    registry: createProviderRegistry(providers),
    ...providers,
  };
};

export const providers = (ctx = c()) => ctx.get("providers");

export type Providers = Omit<ReturnType<typeof initProviders>, "registry">;
export type ProviderRegistry = ReturnType<typeof initProviders>["registry"];
