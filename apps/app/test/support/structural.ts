/** Helpers for comparing JSON structurally: Go's key order and HTML escaping are not part of the contract. */
import type { Json } from "../../src/json/index.ts";

/**
 * Replaces JSON documents embedded in strings (tool call `arguments`, `partial_json`) by their parsed value, so
 * nested JSON text compares independent of key order and escaping.
 */
export const expandEmbeddedJson = (value: Json): Json => {
  if (Array.isArray(value)) return value.map(expandEmbeddedJson);

  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, expandEmbeddedJson(item)]),
    );
  }

  if (typeof value === "string" && /^[{[]/.test(value)) {
    try {
      return { embeddedJson: expandEmbeddedJson(JSON.parse(value)) };
    } catch {
      return value;
    }
  }

  return value;
};

const parseOrUndefined = (text: string): Json | undefined => {
  try {
    return expandEmbeddedJson(JSON.parse(text));
  } catch {
    return undefined;
  }
};

/**
 * Structural form of a response body or SSE stream: JSON documents parse (key order and escaping do not matter),
 * while SSE framing (`event:` / `data:` lines, blank-line separators) and non-JSON text stay exact.
 */
export const structuralBody = (text: string): Json => {
  const whole = parseOrUndefined(text);

  if (whole !== undefined) return { json: whole };

  return text.split("\n").map((line) => {
    if (!line.startsWith("data:")) return line;
    const json = parseOrUndefined(line.slice(5).trim());

    return json === undefined ? line : { data: json };
  });
};
