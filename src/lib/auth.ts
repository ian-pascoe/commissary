import { fetch } from "@tauri-apps/plugin-http";
import { anonymousClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { type StrongholdStore, stronghold } from "./stronghold";

const initAuthClient = (store: StrongholdStore) => {
  console.log(
    "Initializing Auth client with base URL:",
    `${import.meta.env.VITE_API_URL}/auth`,
  );
  const client = createAuthClient({
    baseURL: `${import.meta.env.VITE_API_URL}/auth`,
    plugins: [anonymousClient()],
    fetchOptions: {
      customFetchImpl: fetch,
      credentials: "omit",
      auth: {
        type: "Bearer",
        token: async () => {
          return await store.get("auth-token");
        },
      },
      onSuccess: async ({ response }) => {
        const authToken = response.headers.get("set-auth-token");
        if (authToken) {
          await store.set("auth-token", authToken);
        }
      },
    },
  });
  console.log("Auth client initialized:", client);
  return client;
};
export type AuthClient = ReturnType<typeof initAuthClient>;

export const authClient = initAuthClient(stronghold.store);
