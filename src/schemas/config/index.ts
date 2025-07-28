import * as z from "zod";
import { Theme } from "~/contexts/theme";
import { ProviderConfig } from "./provider";

export const Config = z.object({
  theme: z.optional(Theme).meta({ description: "UI theme preference" }),
  providers: z.optional(z.record(z.string(), ProviderConfig)).meta({
    description: "Configuration for various providers",
  }),
});
export const CreateConfig = Config;
export const UpdateConfig = Config.partial();

export type Config = z.infer<typeof Config>;

export type CreateConfig = z.infer<typeof Config>;
export type CreateConfigInput = z.input<typeof Config>;

export type UpdateConfig = z.infer<typeof UpdateConfig>;
export type UpdateConfigInput = z.input<typeof UpdateConfig>;
