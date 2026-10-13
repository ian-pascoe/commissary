/**
 * Which custom header values the management API shows and which it masks: the Account page and the Keys page
 * (`maskHeaders`) classify headers by these rules. Shared
 * with the browser (no imports), so the panel types a new secret header's value into a password field by the same
 * rule the server masks it by.
 *
 * Masking goes by an allow-list, not by a name pattern: a secret can sit under any name (`Helicone-Auth`,
 * `X-Portkey-Virtual-Key`, `Ocp-Apim-Subscription-Key`, ...).
 */

/** Headers whose values are shown as stored (trimmed, lower-cased names). */
export const SAFE_HEADER_NAMES: ReadonlySet<string> = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "anthropic-beta",
  "anthropic-version",
  "content-type",
  "http-referer",
  "openai-beta",
  "referer",
  "user-agent",
  "x-title",
]);

/** `$name` copies a client header and `$CPA-SESSION-ID` the session id (`executor/helps/custom-headers.ts`). */
const CLIENT_COPY = /^\$\s*[A-Za-z0-9-]+$/;

/**
 * Is a header value a pure copy (`$X-Client-Header`, `$CPA-SESSION-ID`)? It names what is sent, not a secret. Checked
 * in the executor's order (`custom-headers.ts`): exactly `$CPA-SESSION-ID` is the session id; any other value holding
 * `$CPA-SESSION-ID` (any case) is a template that sends its literal rest upstream (`$CPA-SESSION-ID-sk-…`,
 * `$cpa-session-idSECRET`), so it is not a copy; only then is `$name` a client header copy.
 */
export const isHeaderCopy = (value: string): boolean => {
  const text = value.trim();

  if (!CLIENT_COPY.test(text)) return false;

  if (text.slice(1).trim().toUpperCase() === "CPA-SESSION-ID") return true;

  return !text.toUpperCase().includes("$CPA-SESSION-ID");
};

/** Is a header value masked? Every non-empty value is, except safe headers and pure client copies. */
export const isSecretHeader = (name: string, value: string): boolean => {
  const shown = value.trim();

  if (shown === "" || SAFE_HEADER_NAMES.has(name.trim().toLowerCase())) return false;

  return !isHeaderCopy(shown);
};

/** Would a value of this header be masked once saved? (A new value is not a client copy unless it starts with `$`.) */
export const isSecretHeaderName = (name: string): boolean =>
  !SAFE_HEADER_NAMES.has(name.trim().toLowerCase());

/** A masked secret (`[redacted]…`) or the panel's new-secret marker anywhere in a value: never stored as a value. */
export const PLACEHOLDER = /\[(?:redacted|new secret)/i;
