import { fetch } from "@tauri-apps/plugin-http";
import { hc } from "hono/client";
import type api from "~/server";
import type { StrongholdStore } from "./stronghold";

export const initApiClient = (store: StrongholdStore) => {
  return hc<typeof api>(import.meta.env.VITE_API_URL, {
    fetch: fetch,
    headers: async () => {
      const token = await store.get("auth-token");
      if (token) {
        return { Authorization: `Bearer ${token}` };
      }
      return {} as Record<string, string>;
    },
  });
};

export type ApiClient = ReturnType<typeof initApiClient>;
