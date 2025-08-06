import type { streamText } from "ai";
import type { Prettify } from "./prettify";

export type ProviderOptions = Prettify<
  Parameters<typeof streamText>[0]["providerOptions"]
>;
