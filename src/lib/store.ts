import { load } from "@tauri-apps/plugin-store";

export const initStore = async () => {
  const store = await load("store.json");
  return store;
};
