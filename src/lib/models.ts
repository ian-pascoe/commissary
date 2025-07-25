import type { google } from "@ai-sdk/google";

export const googleModels: Parameters<typeof google>[0][] = [
  "gemini-2.5-flash-lite",
];

export const models = {
  google: googleModels,
} as const;
