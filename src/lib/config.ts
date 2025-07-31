import { appDataDir, homeDir, join } from "@tauri-apps/api/path";
import { exists, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { platform } from "@tauri-apps/plugin-os";
import { merge as deepMerge } from "es-toolkit";
import {
  Config,
  CreateConfig,
  type CreateConfigInput,
  UpdateConfig,
  type UpdateConfigInput,
} from "~/schemas/config";

const initConfig = async () => {
  console.log("Initializing config...");
  const resolvedPlatform = platform();
  let configPath = await join(await homeDir(), ".config", "commissary.json");
  // We can't write to anywhere except the app data dir on iOS/Android
  if (resolvedPlatform === "ios" || resolvedPlatform === "android") {
    configPath = await join(await appDataDir(), "config.json");
  }

  const configFileExists = await exists(configPath);
  if (!configFileExists) {
    console.log(
      "Config file does not exist. Creating default config at",
      configPath,
    );
    await writeTextFile(configPath, JSON.stringify({}, null, 2));
  } else {
    console.log("Config file exists at", configPath);
  }

  const get = async () => {
    const text = await readTextFile(configPath);
    try {
      const parsed = JSON.parse(text);
      return Config.parse(parsed);
    } catch (e) {
      throw new Error(`Invalid config file: ${e}`);
    }
  };

  const set = async (input: CreateConfigInput) => {
    const parsedInput = CreateConfig.safeParse(input);
    if (!parsedInput.success) {
      throw new Error(`Invalid config update: ${parsedInput.error.message}`);
    }

    await writeTextFile(configPath, JSON.stringify(parsedInput.data, null, 2));

    return parsedInput.data;
  };

  const merge = async (input: UpdateConfigInput) => {
    const parsedInput = UpdateConfig.safeParse(input);
    if (!parsedInput.success) {
      throw new Error(`Invalid config update: ${parsedInput.error.message}`);
    }

    const currentConfig = await get();
    const mergedConfig = deepMerge(currentConfig, parsedInput.data);
    const parsedMerged = CreateConfig.safeParse(mergedConfig);
    if (!parsedMerged.success) {
      throw new Error(`Invalid merged config: ${parsedMerged.error.message}`);
    }
    await set(parsedMerged.data);
    return parsedMerged.data;
  };

  console.log("Config initialized.");
  return { get, set, merge };
};
export type ConfigInterface = Awaited<ReturnType<typeof initConfig>>;

export const config = await initConfig();
