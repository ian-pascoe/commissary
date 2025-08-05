import type { anthropic } from "@ai-sdk/anthropic";
import type { deepseek } from "@ai-sdk/deepseek";
import type { google } from "@ai-sdk/google";
import type { groq } from "@ai-sdk/groq";
import type { openai } from "@ai-sdk/openai";
import type { openrouter } from "@openrouter/ai-sdk-provider";

export type AnthropicLanguageModelId = Parameters<
  (typeof anthropic)["languageModel"]
>[0];

export type DeepSeekLanguageModelId = Parameters<
  (typeof deepseek)["languageModel"]
>[0];

export type GoogleLanguageModelId = Parameters<
  (typeof google)["languageModel"]
>[0];

export type GroqLanguageModelId = Parameters<(typeof groq)["languageModel"]>[0];

export type OpenAILanguageModelId = Parameters<
  (typeof openai)["languageModel"]
>[0];

export type OpenRouterLanguageModelId = Parameters<
  (typeof openrouter)["languageModel"]
>[0];
