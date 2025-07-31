import { appDataDir, BaseDirectory, join } from "@tauri-apps/api/path";
import { exists, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { type Client, Stronghold } from "@tauri-apps/plugin-stronghold";

export const VAULT_PASSWORD_FILE = ".vault-password";

export type StrongholdStore = {
  get: (key: string) => Promise<string | undefined>;
  set: (key: string, value: string) => Promise<void>;
  remove: (key: string) => Promise<string | undefined>;
};

const initStronghold = async () => {
  console.log("Initializing Stronghold...");
  const vaultPath = await join(await appDataDir(), "vault.hold");

  console.log("Checking for vault password file...");
  const vaultPasswordFileExists = await exists(VAULT_PASSWORD_FILE, {
    baseDir: BaseDirectory.AppData,
  });

  let vaultPassword: string;
  if (vaultPasswordFileExists) {
    console.log("Vault password file found. Reading password...");
    vaultPassword = await readTextFile(VAULT_PASSWORD_FILE, {
      baseDir: BaseDirectory.AppData,
    });
  } else {
    console.log("Vault password file not found. Generating new password...");
    // Create a cryptographically secure random password
    vaultPassword = Array.from(
      crypto.getRandomValues(new Uint8Array(32)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    await writeTextFile(VAULT_PASSWORD_FILE, vaultPassword, {
      baseDir: BaseDirectory.AppData,
    });
  }

  console.log("Loading or creating Stronghold vault...");
  const stronghold = await Stronghold.load(vaultPath, vaultPassword);
  const clientName = "commissary";
  let client: Client;
  try {
    client = await stronghold.loadClient(clientName);
  } catch {
    client = await stronghold.createClient(clientName);
  }

  const store = client.getStore();

  const strongholdData = {
    stronghold,
    client,
    store: {
      get: async (key: string) => {
        const value = await store.get(key);
        if (!value) return undefined;
        return new TextDecoder().decode(new Uint8Array(value));
      },
      set: async (key: string, value: string) => {
        await store.insert(key, Array.from(new TextEncoder().encode(value)));
        await stronghold.save();
      },
      remove: async (key: string) => {
        const value = await store.remove(key);
        if (!value) return undefined;
        await stronghold.save();
        return new TextDecoder().decode(new Uint8Array(value));
      },
    },
  };

  console.log("Stronghold initialized successfully");
  return strongholdData;
};
export type StrongholdInterface = Awaited<ReturnType<typeof initStronghold>>;

export const stronghold = await initStronghold();
export const strongholdClient = stronghold.client;
export const strongholdStore = stronghold.store;
