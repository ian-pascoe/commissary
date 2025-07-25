import { fetch } from "@tauri-apps/plugin-http";
import { createAuthClient } from "better-auth/client";
import { anonymousClient } from "better-auth/client/plugins";
import type { StrongholdStore } from "./stronghold";

export const initAuthClient = (store: StrongholdStore) => {
  return createAuthClient({
    baseURL: `${import.meta.env.VITE_API_URL}/auth`,
    plugins: [anonymousClient()],
    fetchOptions: {
      customFetchImpl: fetch,
      auth: {
        type: "Bearer",
        token: () => store.get("auth-token"),
      },
      onSuccess: async ({ response }) => {
        const authToken = response.headers.get("set-auth-token");
        if (authToken) {
          await store.set("auth-token", authToken);
        }
      },
    },
  });
};

export type AuthClient = ReturnType<typeof initAuthClient>;
