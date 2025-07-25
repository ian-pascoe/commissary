import * as z from "zod";
import { models } from "~/lib/models";
import type { ProviderRegistry } from "~/server/lib/model";

export const ModelId = z.custom<
  Parameters<ProviderRegistry["languageModel"]>[0]
>(
  (v) => {
    if (typeof v !== "string") return false;
    const [vProvider, vModel] = v.split(":");
    return Object.entries(models).some(([provider, models]) =>
      models.some((model) => provider === vProvider && model === vModel),
    );
  },
  { error: "Invalid model ID" },
);
export type ModelId = z.infer<typeof ModelId>;
