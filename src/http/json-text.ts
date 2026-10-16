/**
 * JSON text helpers. Commissary emits plain `JSON.stringify` output (no HTML escaping, keys in the order they are
 * built); only values that feed a hash or an equality check go through {@link stableStringify}.
 */

import { isJsonArray, isJsonObject, type Json } from "../json/index.ts";

/** `json.Valid`. */
export const isValidJson = (text: string): boolean => {
  try {
    JSON.parse(text);

    return true;
  } catch {
    return false;
  }
};

/** `json.Compact`: removes whitespace outside string literals, leaving everything else (numbers, escapes) intact. */
export const compactJson = (text: string): string => {
  let out = "";
  let inString = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);

    if (inString) {
      out += ch;

      if (ch === "\\") {
        out += text[i + 1] ?? "";
        i++;
      } else if (ch === '"') {
        inString = false;
      }

      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") {
      out += ch;
    }
  }

  return out;
};

/**
 * `JSON.stringify` with every object's keys sorted (recursively, UTF-16 code unit order). The only sorted serialiser:
 * use it where the text feeds a hash or an equality check, which must be stable but need not match any other
 * implementation's bytes. Output sent to clients keeps build order (`JSON.stringify`).
 */
export const stableStringify = (value: Json): string => {
  if (isJsonArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  if (isJsonObject(value)) {
    const members = Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key] ?? null)}`);

    return `{${members.join(",")}}`;
  }

  return JSON.stringify(value);
};
