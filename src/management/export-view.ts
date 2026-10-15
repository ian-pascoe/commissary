/**
 * The export of an org (`GET /v9/management/export`, ADR 0027), new in the Workers port: what an org owner may keep
 * before the org is deleted. It holds the org's settings, its shared config (with every secret as a preview, like every
 * other view of it), its price overrides, the credentials it holds (summaries, never tokens), and who belongs. Usage
 * records are not part of it: the usage routes already page and export them.
 */
import { maskHeaders, isSecretName, maskSecret } from "../credentials/summary.ts";
import { isJsonObject, type Json, type JsonObject } from "../json/index.ts";

/** A proxy URL's credentials are secret; the rest of the address is not. */
const maskProxyUrl = (value: string): string => {
  if (!URL.canParse(value)) return value.includes("@") ? maskSecret(value) : value;
  const url = new URL(value);

  if (url.username === "" && url.password === "") return value;
  url.username = "[redacted]";
  url.password = "";

  return url.toString();
};

const isStringRecord = (value: Json): value is Record<string, string> =>
  isJsonObject(value) && Object.values(value).every((item) => typeof item === "string");

/**
 * `value` with every secret replaced by a preview: the values of keys named like a secret (`api-key`, `token`,
 * `secret`, `password`, ...) including lists of them, the secret-looking values of `headers`, and the credentials in a
 * `proxy-url`. Everything else is kept, so the export reads like the config it was made from.
 */
export const maskConfigSecrets = (value: Json): Json => {
  if (Array.isArray(value)) return value.map(maskConfigSecrets);

  if (!isJsonObject(value)) return value;

  const masked: JsonObject = {};

  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;

    if (isSecretName(key) && typeof item === "string") masked[key] = maskSecret(item);
    else if (
      isSecretName(key) &&
      Array.isArray(item) &&
      item.every((entry) => typeof entry === "string")
    )
      masked[key] = item.map((entry) => maskSecret(String(entry)));
    else if (key === "headers" && isStringRecord(item)) masked[key] = maskHeaders(item);
    else if (key === "proxy-url" && typeof item === "string") masked[key] = maskProxyUrl(item);
    else masked[key] = maskConfigSecrets(item);
  }

  return masked;
};
