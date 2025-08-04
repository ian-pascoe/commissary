import type { anthropic } from "@ai-sdk/anthropic";
import type { google } from "@ai-sdk/google";
import type { groq } from "@ai-sdk/groq";
import type { openai } from "@ai-sdk/openai";

export type AnthropicLanguageModelId = Parameters<
  (typeof anthropic)["languageModel"]
>[0];
export type GoogleLanguageModelId = Parameters<
  (typeof google)["languageModel"]
>[0];
export type GroqLanguageModelId = Parameters<(typeof groq)["languageModel"]>[0];
export type OpenAILanguageModelId = Parameters<
  (typeof openai)["languageModel"]
>[0];
