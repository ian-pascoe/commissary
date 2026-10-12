/**
 * Upstream headers of the OpenCode Zen/Go gateways.
 *
 * Deliberate deviation from Go (no OpenCode provider there; see docs/ARCHITECTURE.md "OpenCode Zen and OpenCode
 * Go"). The gateways want a stable `x-opencode-session` per conversation (OpenCode Go answers 400 `MissingSessionID`
 * without one) and a client of its own (`User-Agent`, `x-opencode-client`). Each protocol authenticates with its SDK's
 * native header: `Authorization: Bearer` for chat and Responses, `x-api-key` (plus `anthropic-version`) for Messages,
 * `x-goog-api-key` for Gemini. Configured custom headers (`header:<Name>` attributes) are applied last and win.
 */
import type { OpenCodeProtocol } from "../../config/schema.ts";
import { normalizeExplicitId } from "../../handlers/session.ts";
import { applyCustomHeaders } from "../helps/custom-headers.ts";
import { providerSessionUuid } from "../helps/uuid.ts";
import type { CredentialSnapshot } from "../picker.ts";
import type { ExecutorOptions } from "../types.ts";

/** Stable client identity (OpenCode asks clients not to pose as a generic SDK). */
export const OPENCODE_USER_AGENT = "cf-llm-proxy";

/** `x-opencode-client` value. */
export const OPENCODE_CLIENT = "cf-llm-proxy";

/** Header carrying the conversation id. */
export const OPENCODE_SESSION_HEADER = "x-opencode-session";

export const ANTHROPIC_VERSION = "2023-06-01";

/** Namespace of the derived session UUIDs (`providerSessionUuid`). */
const SESSION_NAMESPACE = "opencode";

/**
 * The `x-opencode-session` value of a request: the client's own `x-opencode-session` unchanged; else a stable UUID of
 * the explicit session identity, the WebSocket execution session or the derived conversation identity; else a random
 * UUID. Another client's raw session id is never forwarded.
 */
export const openCodeSessionId = (options: ExecutorOptions): string => {
  const own = normalizeExplicitId(options.headers.get(OPENCODE_SESSION_HEADER) ?? undefined);

  if (own !== "") return own;

  const candidates = [
    ["session", options.metadata.sessionId],
    ["execution-session", options.metadata.websocket?.sessionId],
    ["derived-session", options.metadata.derivedSessionId],
  ] as const;

  for (const [kind, identity] of candidates) {
    const uuid = providerSessionUuid(SESSION_NAMESPACE, kind, identity);

    if (uuid !== "") return uuid;
  }

  return crypto.randomUUID();
};

/** Auth headers of a protocol. */
export const openCodeAuthHeaders = (protocol: OpenCodeProtocol, apiKey: string) => {
  switch (protocol) {
    case "messages":
      return { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION };
    case "gemini":
      return { "x-goog-api-key": apiKey };
    default:
      return { authorization: `Bearer ${apiKey}` };
  }
};

/** Client identity and session headers shared by every protocol. */
export const openCodeIdentityHeaders = (options: ExecutorOptions) => ({
  "user-agent": OPENCODE_USER_AGENT,
  "x-opencode-client": OPENCODE_CLIENT,
  [OPENCODE_SESSION_HEADER]: openCodeSessionId(options),
});

/** Full request headers of a chat, Responses or Messages attempt (custom headers applied last). */
export const openCodeHeaders = (input: {
  readonly credential: CredentialSnapshot;
  readonly options: ExecutorOptions;
  readonly protocol: OpenCodeProtocol;
  readonly apiKey: string;
  readonly stream: boolean;
}): Record<string, string> => {
  const headers = {
    "content-type": "application/json",
    ...openCodeAuthHeaders(input.protocol, input.apiKey),
    ...openCodeIdentityHeaders(input.options),
    ...(input.stream
      ? { accept: "text/event-stream", "cache-control": "no-cache" }
      : { accept: "application/json" }),
  };

  return applyCustomHeaders(
    headers,
    input.credential,
    input.options.headers,
    input.options.metadata.sessionId,
  );
};
