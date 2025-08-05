import * as z from "zod";
import { PreloadedProviderId } from "~/lib/preloaded-providers";

export const ProviderId: z.ZodType<ProviderId, string> = z.union([
  PreloadedProviderId,
  z.string().min(1),
]);
export type ProviderId = PreloadedProviderId | (string & {});

export const ProviderSdk = z.enum([
  "@ai-sdk/anthropic",
  "@ai-sdk/google",
  "@ai-sdk/groq",
  "@ai-sdk/openai",
  "@ai-sdk/openai-compatible",
  "@openrouter/ai-sdk-provider",
]);
export type ProviderSdk = z.infer<typeof ProviderSdk>;

export const ProviderAuthConfig = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("api-key"),
    apiKey: z.string().meta({
      description:
        "The API key. If wrapped in sh(), it points to a secret in Stronghold.",
    }),
  }),
  z.object({
    type: z.literal("oauth"),
    accessToken: z.string().meta({
      description:
        "The OAuth access token. If wrapped in sh(), it points to a secret in Stronghold.",
    }),
    refreshToken: z.string().meta({
      description:
        "The OAuth refresh token. If wrapped in sh(), it points to a secret in Stronghold.",
    }),
    expiresAt: z
      .number()
      .meta({ description: "Unix timestamp in milliseconds" }),
  }),
  z.object({
    type: z.literal("aws"),
    accessKeyId: z.string().meta({
      description:
        "The AWS access key ID. If wrapped in sh(), it points to a secret in Stronghold.",
    }),
    secretAccessKey: z.string().meta({
      description:
        "The AWS secret access key. If wrapped in sh(), it points to a secret in Stronghold.",
    }),
  }),
]);
export type ProviderAuthConfig = z.infer<typeof ProviderAuthConfig>;

export const ProviderModelConfig = z.object({
  name: z
    .optional(z.string())
    .meta({ description: "Human-readable name for the model" }),
});
export type ProviderModelConfig = z.infer<typeof ProviderModelConfig>;

export const ProviderConfig = z.object({
  name: z
    .optional(z.string())
    .meta({ description: "Human-readable name for the provider" }),
  sdk: z.optional(ProviderSdk).meta({
    description:
      "The SDK to use for this provider. Must be one of the supported SDKs.",
  }),
  baseUrl: z
    .optional(z.url())
    .meta({ description: "Base URL for the provider API" }),
  auth: z
    .optional(ProviderAuthConfig)
    .meta({ description: "Authentication configuration for the provider" }),
  models: z.optional(z.record(z.string(), ProviderModelConfig)).meta({
    description:
      "Model-specific configuration. Keys are model IDs, values are model-specific settings.",
  }),
});
export type ProviderConfig = z.infer<typeof ProviderConfig>;
