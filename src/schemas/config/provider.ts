import * as z from "zod";

export const AuthConfig = z.discriminatedUnion("type", [
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
export type AuthConfig = z.infer<typeof AuthConfig>;

export const ModelConfig = z.object({
  name: z
    .optional(z.string())
    .meta({ description: "Human-readable name for the model" }),
});
export type ModelConfig = z.infer<typeof ModelConfig>;

export const ProviderConfig = z.object({
  name: z
    .optional(z.string())
    .meta({ description: "Human-readable name for the provider" }),
  baseUrl: z
    .optional(z.url())
    .meta({ description: "Base URL for the provider API" }),
  auth: z
    .optional(AuthConfig)
    .meta({ description: "Authentication configuration for the provider" }),
  models: z.optional(z.record(z.string(), ModelConfig)).meta({
    description:
      "Model-specific configuration. Keys are model IDs, values are model-specific settings.",
  }),
});
export type ProviderConfig = z.infer<typeof ProviderConfig>;
