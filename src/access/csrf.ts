// Cross-site request protections for the Access-protected zones. New in the Workers port: Go authenticates with a
// management key / API key that browsers never attach on their own, while the Access session cookie
// (`CF_Authorization`) is sent by the browser automatically, so a page on another site could drive an admin's
// session (CSRF) or open a WebSocket with it (cross-site WebSocket hijacking).
//
// Non-browser clients (curl, SDKs, Claude Code, Codex) send neither `Origin` nor `Sec-Fetch-*` headers and are not
// affected. Browsers always send `Origin` on cross-origin fetches, form posts and WebSocket handshakes, and
// `Sec-Fetch-Site` on every request; the control panel is served by the Worker itself (same origin).
import { isPanelPagePath, MANAGEMENT_PREFIX, normalizedPath, unscopedPath } from "./routes.ts";
import type { AccessZone } from "./routes.ts";

export interface CrossSiteRejection {
  readonly status: 403 | 415;
  readonly message: string;
}

type Headers = Readonly<Record<string, string | undefined>>;

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const CROSS_SITE_REJECTED: CrossSiteRejection = {
  status: 403,
  message: "Cross-site request rejected",
};

const CROSS_ORIGIN_WEBSOCKET_REJECTED: CrossSiteRejection = {
  status: 403,
  message: "Cross-origin WebSocket rejected",
};

const UNSUPPORTED_CONTENT_TYPE: CrossSiteRejection = {
  status: 415,
  message: "Unsupported Content-Type",
};

const hostOf = (url: string): string | undefined => {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
};

/** `Origin` is present and is not the Worker's own host (`null` and unparsable origins count as foreign). */
export const hasForeignOrigin = (headers: Headers, requestUrl: string): boolean => {
  const origin = (headers["origin"] ?? "").trim();

  if (origin === "") return false;
  const host = hostOf(origin);

  return host === undefined || host === "" || host !== hostOf(requestUrl);
};

/** `Sec-Fetch-Site` says the request was initiated by another origin (`same-site` = a sibling subdomain). */
const fetchedCrossSite = (headers: Headers): boolean => {
  const site = (headers["sec-fetch-site"] ?? "").trim().toLowerCase();

  return site === "cross-site" || site === "same-site";
};

const isWebSocketUpgrade = (headers: Headers): boolean =>
  (headers["upgrade"] ?? "")
    .toLowerCase()
    .split(",")
    .some((token) => token.trim() === "websocket");

const header = (headers: Headers, name: string): string =>
  (headers[name] ?? "").trim().toLowerCase();

/**
 * A top-level navigation (link, bookmark, typed URL) to a panel page, which may legitimately come from another site:
 * `Sec-Fetch-Mode: navigate` and `Sec-Fetch-Dest: document` (not a frame: `iframe`/`frame`/`embed`/`object` are
 * refused, against clickjacking), to a panel page or the legacy panel address. The management API
 * (`/v8/management*`) has no such page: OAuth provider redirects land on the public callback paths. The pages of an
 * org (`/o/<slug>/accounts`) are panel pages like the unscoped ones.
 */
const isPanelNavigation = (method: string, headers: Headers, requestUrl: string): boolean =>
  (method === "GET" || method === "HEAD") &&
  header(headers, "sec-fetch-mode") === "navigate" &&
  header(headers, "sec-fetch-dest") === "document" &&
  isPanelPagePath(normalizedPath(requestUrl) ?? "");

const mediaType = (headers: Headers): string =>
  (headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ?? "";

const isJsonType = (type: string): boolean => type === "application/json" || type.endsWith("+json");

const YAML_TYPES = new Set(["application/yaml", "application/x-yaml", "text/yaml", "text/x-yaml"]);

/**
 * Content types accepted by management writes: JSON everywhere, multipart for credential uploads, YAML for
 * `PUT /config.yaml`. The CORS-safelisted types (`text/plain`, form encoding, a bare body without type) are refused,
 * so a write can never be a "simple" cross-site request. `path` is the path without the org of an org-scoped request
 * (`/v8/management/orgs/<slug>/config.yaml` is `/v8/management/config.yaml`).
 */
const managementTypeAllowed = (method: string, path: string, type: string): boolean => {
  if (isJsonType(type)) return true;

  if (
    method === "POST" &&
    (path === `${MANAGEMENT_PREFIX}/credentials` || path === `${MANAGEMENT_PREFIX}/oauth/import`)
  ) {
    return type === "multipart/form-data";
  }

  if (method === "PUT" && path === `${MANAGEMENT_PREFIX}/config.yaml`) return YAML_TYPES.has(type);

  return false;
};

/** A write without `Content-Type` is only accepted when it has no body (`DELETE ?name=`, a bare `POST .../refresh`). */
const hasBody = (headers: Headers): boolean => {
  const length = (headers["content-length"] ?? "").trim();

  if (length !== "" && length !== "0") return true;

  return (headers["transfer-encoding"] ?? "").trim() !== "";
};

/**
 * Checks a request for the protected (`/v1*`, ...) and management zones before authentication; `undefined` when it may
 * proceed. Rules:
 * - WebSocket upgrades whose `Origin` is not the Worker's own host are refused (cross-site WebSocket hijacking).
 * - State-changing methods are refused when `Sec-Fetch-Site` is `cross-site`/`same-site` or `Origin` is foreign.
 * - Management requests of any method are refused for a foreign `Origin`, and for a cross-site `Sec-Fetch-Site` unless
 *   they are top-level document navigations to a panel page or `/management.html` (a link to `/accounts` still
 *   works; a frame or any `/v8/management` request does not).
 * - Management writes need a JSON body (multipart for uploads, YAML for `config.yaml`) or no body at all.
 */
export const crossSiteRejection = (
  method: string,
  headers: Headers,
  requestUrl: string,
  zone: Exclude<AccessZone, "public">,
): CrossSiteRejection | undefined => {
  const verb = method.toUpperCase();
  const foreignOrigin = hasForeignOrigin(headers, requestUrl);

  if (isWebSocketUpgrade(headers) && foreignOrigin) return CROSS_ORIGIN_WEBSOCKET_REJECTED;
  const unsafe = !SAFE_METHODS.has(verb);

  if (unsafe && (foreignOrigin || fetchedCrossSite(headers))) return CROSS_SITE_REJECTED;

  if (zone !== "management") return undefined;

  if (foreignOrigin || (fetchedCrossSite(headers) && !isPanelNavigation(verb, headers, requestUrl)))
    return CROSS_SITE_REJECTED;

  if (!unsafe) return undefined;
  const type = mediaType(headers);

  if (type === "") return hasBody(headers) ? UNSUPPORTED_CONTENT_TYPE : undefined;

  return managementTypeAllowed(verb, unscopedPath(normalizedPath(requestUrl) ?? ""), type)
    ? undefined
    : UNSUPPORTED_CONTENT_TYPE;
};
