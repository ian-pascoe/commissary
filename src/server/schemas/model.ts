import * as z from "zod";
import { type ProviderRegistry, providers } from "~/server/lib/providers";

export const RemoteModelId = z.custom<
  Parameters<ProviderRegistry["languageModel"]>[0]
>(
  (v) => {
    if (typeof v !== "string") return false;
    try {
      providers().registry.languageModel(v as any);
      return true;
    } catch {
      return false;
    }
  },
  { error: "Invalid model ID" },
);
export type RemoteModelId = z.infer<typeof RemoteModelId>;
