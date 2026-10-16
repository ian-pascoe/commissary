// Cross-site request protections for the Access-protected zones. New in the Workers port: Go authenticates with a
// management key / API key that browsers never attach on their own, while the Access session cookie
// (`CF_Authorization`) is sent by the browser automatically, so a page on another site could drive an admin's
// session (CSRF) or open a WebSocket with it (cross-site WebSocket hijacking).
//
// Non-browser clients (curl, SDKs, Claude Code, Codex) send neither `Origin` nor `Sec-Fetch-*` headers and are not
// affected. Browsers always send `Origin` on cross-origin fetches, form posts and WebSocket handshakes, and
// `Sec-Fetch-Site` on every request; the control panel is served by the Worker itself (same origin).
//
// The rules are here; what a management path is (a panel page, a route that takes an upload) is the Worker's, which
// owns the routes and passes it in ({@link ManagementTarget}).

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
 * What the Worker's routes say about a management request (its path zones): whether it is for a panel page, and which
 * body types its route takes besides JSON.
 */
export interface ManagementTarget {
  /**
   * A page of the panel (also an org's, `/o/<slug>/accounts`) or the legacy panel address: a top-level navigation to
   * it may come from another site. The management API (`/v9/management*`) has no such page: OAuth provider redirects
   * land on the public callback paths.
   */
  readonly panelPage: boolean;
  /**
   * Lowercased media types (no parameters) a write to this route may carry besides JSON: multipart for credential
   * uploads, YAML for the config import; none for every other route.
   */
  readonly bodyTypes: ReadonlyArray<string>;
}

/**
 * A top-level navigation (link, bookmark, typed URL) to a panel page, which may legitimately come from another site:
 * `Sec-Fetch-Mode: navigate` and `Sec-Fetch-Dest: document` (not a frame: `iframe`/`frame`/`embed`/`object` are
 * refused, against clickjacking).
 */
const isPanelNavigation = (method: string, headers: Headers, target: ManagementTarget): boolean =>
  (method === "GET" || method === "HEAD") &&
  header(headers, "sec-fetch-mode") === "navigate" &&
  header(headers, "sec-fetch-dest") === "document" &&
  target.panelPage;

const mediaType = (headers: Headers): string =>
  (headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ?? "";

const isJsonType = (type: string): boolean => type === "application/json" || type.endsWith("+json");

/**
 * Content types accepted by management writes: JSON everywhere, and the route's own {@link ManagementTarget.bodyTypes}.
 * The CORS-safelisted types (`text/plain`, form encoding, a bare body without type) are refused unless a route names
 * one, so a write can never be a "simple" cross-site request.
 */
const managementTypeAllowed = (type: string, target: ManagementTarget): boolean =>
  isJsonType(type) || target.bodyTypes.includes(type);

/** A write without `Content-Type` is only accepted when it has no body (`DELETE ?name=`, a bare `POST .../refresh`). */
const hasBody = (headers: Headers): boolean => {
  const length = (headers["content-length"] ?? "").trim();

  if (length !== "" && length !== "0") return true;

  return (headers["transfer-encoding"] ?? "").trim() !== "";
};

/**
 * Checks a request for the protected (`/v1*`, ...) zone (`management` undefined) or the management zone (the
 * {@link ManagementTarget} of its path) before authentication; `undefined` when it may proceed. Rules:
 * - WebSocket upgrades whose `Origin` is not the Worker's own host are refused (cross-site WebSocket hijacking).
 * - State-changing methods are refused when `Sec-Fetch-Site` is `cross-site`/`same-site` or `Origin` is foreign.
 * - Management requests of any method are refused for a foreign `Origin`, and for a cross-site `Sec-Fetch-Site` unless
 *   they are top-level document navigations to a panel page or `/management.html` (a link to `/accounts` still
 *   works; a frame or any `/v9/management` request does not).
 * - Management writes need a JSON body (or one of the route's `bodyTypes`: multipart for uploads, YAML for the config
 *   import) or no body at all.
 */
export const crossSiteRejection = (
  method: string,
  headers: Headers,
  requestUrl: string,
  management: ManagementTarget | undefined,
): CrossSiteRejection | undefined => {
  const verb = method.toUpperCase();
  const foreignOrigin = hasForeignOrigin(headers, requestUrl);

  if (isWebSocketUpgrade(headers) && foreignOrigin) return CROSS_ORIGIN_WEBSOCKET_REJECTED;
  const unsafe = !SAFE_METHODS.has(verb);

  if (unsafe && (foreignOrigin || fetchedCrossSite(headers))) return CROSS_SITE_REJECTED;

  if (management === undefined) return undefined;

  if (foreignOrigin || (fetchedCrossSite(headers) && !isPanelNavigation(verb, headers, management)))
    return CROSS_SITE_REJECTED;

  if (!unsafe) return undefined;
  const type = mediaType(headers);

  if (type === "") return hasBody(headers) ? UNSUPPORTED_CONTENT_TYPE : undefined;

  return managementTypeAllowed(type, management) ? undefined : UNSUPPORTED_CONTENT_TYPE;
};
