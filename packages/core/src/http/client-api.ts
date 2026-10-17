/**
 * Which paths are the client API (ADR 0030): the API Worker serves them, the app Worker serves everything else, and on
 * a stage with one host zone routes send them to the API Worker (alchemy.run.ts). Mirrors the Go route groups in
 * internal/api/server_routes.go that use AuthMiddleware, without the management API.
 */

/**
 * The client API's path prefixes. `/v1` also covers `/v1beta*` and `/v1internal`; `/chat/completions`, `/completions`
 * and `/responses` are the unprefixed aliases of the `/v1` routes (not in Go, see Models' handlers/openai/routes.ts).
 */
export const CLIENT_API_PREFIXES = [
  "/v1",
  "/openai/v1",
  "/backend-api/codex",
  "/chat/completions",
  "/completions",
  "/responses",
] as const;

/**
 * The path of a request URL (absolute or origin-relative), percent-decoded, with duplicate slashes collapsed and
 * lowercased; `undefined` when the URL cannot be parsed.
 */
export const normalizedPath = (requestUrl: string): string | undefined => {
  let path: string;

  try {
    path = new URL(requestUrl, "http://invalid.invalid").pathname;
  } catch {
    return undefined;
  }

  try {
    path = decodeURIComponent(path);
  } catch {
    // Keep the raw path when it is not valid percent-encoding.
  }

  return path.replace(/\/{2,}/g, "/").toLowerCase();
};

/**
 * Whether a normalised path ({@link normalizedPath}) is on the client API. Matching is deliberately a superset of what
 * the routers match (any path under a prefix), so an unusual spelling of a client API path is never taken for another
 * zone's.
 */
export const isClientApiPath = (path: string): boolean =>
  CLIENT_API_PREFIXES.some((prefix) => path.startsWith(prefix));
