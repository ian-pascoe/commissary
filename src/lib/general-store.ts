import { load } from "@tauri-apps/plugin-store";

export const initGeneralStore = async () => {
  const store = await load("store.json");
  return store;
};

export type GeneralStore = Awaited<ReturnType<typeof initGeneralStore>>;
