import { fetch } from "@tauri-apps/plugin-http";
import { hc } from "hono/client";
import type api from "~/server";
import { type StrongholdStore, stronghold } from "./stronghold";

const initApiClient = (store: StrongholdStore) => {
  console.log(
    "Initializing API client with base URL:",
    import.meta.env.VITE_API_URL,
  );
  const client = hc<typeof api>(import.meta.env.VITE_API_URL, {
    fetch: fetch,
    headers: async () => {
      const token = await store.get("auth-token");
      if (token) {
        return { Authorization: `Bearer ${token}` };
      }
      return {} as Record<string, string>;
    },
    init: { credentials: "omit" },
  });
  console.log("API client initialized:", client);
  return client;
};
export type ApiClient = ReturnType<typeof initApiClient>;

export const apiClient = initApiClient(stronghold.store);
