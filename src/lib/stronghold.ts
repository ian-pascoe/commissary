import { appDataDir, BaseDirectory, join } from "@tauri-apps/api/path";
import { exists, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { type Client, Stronghold } from "@tauri-apps/plugin-stronghold";

export type StrongholdStore = {
  get: (key: string) => Promise<string | undefined>;
  set: (key: string, value: string) => Promise<void>;
  remove: (key: string) => Promise<string | undefined>;
};

let cachedStronghold: {
  stronghold: Stronghold;
  client: Client;
  store: StrongholdStore;
} | null = null;

export const initStronghold = async () => {
  if (cachedStronghold) {
    return cachedStronghold;
  }

  console.log("Initializing Stronghold...");
  const vaultPath = await join(await appDataDir(), "vault");
  const vaultPasswordFileExists = await exists("vault-password.txt", {
    baseDir: BaseDirectory.AppConfig,
  });

  let vaultPassword: string;
  if (vaultPasswordFileExists) {
    vaultPassword = await readTextFile("vault-password.txt", {
      baseDir: BaseDirectory.AppConfig,
    });
  } else {
    // Create a cryptographically secure random password
    vaultPassword = Array.from(
      crypto.getRandomValues(new Uint8Array(32)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    await writeTextFile("vault-password.txt", vaultPassword, {
      baseDir: BaseDirectory.AppConfig,
    });
  }

  const stronghold = await Stronghold.load(vaultPath, vaultPassword);
  const clientName = "commissary";
  let client: Client;
  try {
    client = await stronghold.loadClient(clientName);
  } catch {
    client = await stronghold.createClient(clientName);
  }

  const store = client.getStore();

  cachedStronghold = {
    stronghold,
    client,
    store: {
      get: async (key: string) => {
        const value = await store.get(key);
        if (!value) return undefined;
        return new TextDecoder().decode(new Uint8Array(value));
      },
      set: async (key: string, value: string) => {
        return await store.insert(
          key,
          Array.from(new TextEncoder().encode(value)),
        );
      },
      remove: async (key: string) => {
        const value = await store.remove(key);
        if (!value) return undefined;
        return new TextDecoder().decode(new Uint8Array(value));
      },
    },
  };

  console.log("Stronghold initialized successfully");
  return cachedStronghold;
};
