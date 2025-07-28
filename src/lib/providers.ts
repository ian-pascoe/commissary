import * as z from "zod";
import type { ProviderConfig } from "~/schemas/config/provider";

export const providers: Record<string, ProviderConfig> = {
  google: {
    name: "Google Generative AI",
    models: {
      "gemini-2.5-flash": {},
    },
  },
  openai: {
    name: "OpenAI",
    models: {
      "gpt-4o-mini": {},
    },
  },
};

export const ProviderId = z.enum(
  Object.keys(providers) as Array<keyof typeof providers>,
);
export type ProviderId = z.infer<typeof ProviderId>;
