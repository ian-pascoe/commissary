import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createProviderRegistry } from "ai";
import type { Context } from "hono";
import type { Env } from "../types/hono";
import { c } from "../utils/context";
import { env } from "../utils/env";
import { createDeepSeek } from "@ai-sdk/deepseek";

export const initProviderRegistry = (c: Context<Env>) => {
  return createProviderRegistry({
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
  });
};

export const providerRegistry = (ctx = c()) => ctx.get("providerRegistry");

export type ProviderRegistry = ReturnType<typeof initProviderRegistry>;
