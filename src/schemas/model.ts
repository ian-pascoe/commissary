import * as z from "zod";
import {
  type ProviderRegistry,
  providerRegistry,
} from "~/server/lib/provider-registry";

export const RemoteModelId = z.custom<
  Parameters<ProviderRegistry["languageModel"]>[0]
>(
  (v) => {
    if (typeof v !== "string") return false;
    try {
      providerRegistry().languageModel(v as any);
      return true;
    } catch {
      return false;
    }
  },
  { error: "Invalid model ID" },
);
export type RemoteModelId = z.infer<typeof RemoteModelId>;
