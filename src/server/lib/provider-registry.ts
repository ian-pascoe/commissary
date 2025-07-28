import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createProviderRegistry } from "ai";
import type { Context } from "hono";
import type { Env } from "../types/hono";
import { c } from "../utils/context";
import { env } from "../utils/env";

export const initProviderRegistry = (c: Context<Env>) => {
  return createProviderRegistry({
    google: createGoogleGenerativeAI({
      apiKey: env(c).GOOGLE_API_KEY,
    }),
    openai: createOpenAI({
      apiKey: env(c).OPENAI_API_KEY,
    })
  });
};

export const providerRegistry = (ctx = c()) => ctx.get("providerRegistry");

export type ProviderRegistry = ReturnType<typeof initProviderRegistry>;
