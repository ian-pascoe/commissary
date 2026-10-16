// Route policy: which paths need Cloudflare Access authentication (mirrors the Go route groups in
// internal/api/server_routes.go that use AuthMiddleware) and which need an administrator. Also the org addresses of the
// management zone (ADR 0021), which are new in the Workers port.
import { Schema } from "effect";
import { OrgSlug } from "@commissary/core";

/**
 * Paths under these prefixes require a caller: an API key or, where the org still accepts them, an Access sign-in on
 * the client API (`authenticate.ts`), an Access sign-in on `/v9/management`. `/v1` also covers `/v1beta*` and
 * `/v1internal`;
 * `/chat/completions`, `/completions` and `/responses` are the unprefixed aliases of the `/v1` routes (not in Go, see
 * handlers/openai/routes.ts).
 */
export const PROTECTED_PREFIXES = [
  "/v1",
  "/openai/v1",
  "/backend-api/codex",
  "/chat/completions",
  "/completions",
  "/responses",
  "/v9/management",
] as const;

/** Paths under this prefix additionally require the principal to be on the admin allow-list. */
export const MANAGEMENT_PREFIX = "/v9/management";

/**
 * Where Go serves the upstream panel. Here it redirects to `/` (`management/web-panel.ts`), and stays in the
 * management zone like the panel it points to: only administrators get the redirect.
 */
export const LEGACY_PANEL_PATH = "/management.html";

/**
 * Top-level paths of the new control panel (`apps/web`, served by `src/management/web-panel.ts`): `/` itself, the
 * panel's pages and their sub-paths, and its bundled files under `/assets`. Like the management API, only
 * administrators get them. Deviation from Go: `/` serves the panel instead of the public JSON banner.
 */
export const PANEL_SECTIONS = [
  "accounts",
  "keys",
  "models",
  "usage",
  "settings",
  "members",
  "grants",
  "my-models",
  "api-keys",
  "limits",
  "management-keys",
  "people",
  "assets",
] as const;

const inSection = (path: string, section: string): boolean =>
  path === `/${section}` || path.startsWith(`/${section}/`);

/** Where the org of a panel page comes from: `/o/<slug>/accounts` is the page `/accounts` of the org `<slug>`. */
export const PANEL_ORG_PREFIX = "/o";

/** The segment after `/v9/management` that is followed by an org slug: `/v9/management/orgs/<slug>/config`. */
export const ORGS_SEGMENT = "orgs";

const isPanelPath = (path: string): boolean =>
  path === "/" ||
  path.startsWith(`${PANEL_ORG_PREFIX}/`) ||
  PANEL_SECTIONS.some((section) => inSection(path, section));

const isOrgSlug = Schema.is(OrgSlug);

const decodedLowercase = (segment: string): string => {
  try {
    return decodeURIComponent(segment).toLowerCase();
  } catch {
    return segment.toLowerCase();
  }
};

/** An org addressed by the path of a management request, and the path the request has once the org is taken out. */
export interface OrgAddress {
  readonly slug: OrgSlug;
  /** `/v9/management/<rest>` for `/v9/management/orgs/<slug>/<rest>`, `/<page>` for `/o/<slug>/<page>` (`/` for none). */
  readonly path: string;
}

/**
 * The org a path addresses, `undefined` for a path of no org: `/v9/management/orgs/<slug>/<rest>` (the management API
 * of the org; `/v9/management/orgs` and `/v9/management/orgs/<slug>` themselves are platform-level routes and address
 * none) and `/o/<slug>[/<page>]` (a page of the panel, not `/assets`). Like the router, it skips duplicate slashes and
 * compares the fixed segments case-insensitively and percent-decoded; the rest of the path stays as sent.
 */
export const parseOrgAddress = (pathname: string): OrgAddress | undefined => {
  const segments = pathname.split("/");
  let index = 0;

  const next = (): string | undefined => {
    while (segments[index] === "") index++;
    const segment = segments[index];

    if (segment === undefined) return undefined;
    index++;

    return decodedLowercase(segment);
  };

  // The rest of the path from the next non-empty segment, as sent.
  const rest = (): string | undefined => {
    while (segments[index] === "") index++;

    return segments[index] === undefined ? undefined : segments.slice(index).join("/");
  };

  const first = next();

  if (first === "v9") {
    if (next() !== "management" || next() !== ORGS_SEGMENT) return undefined;
    const slug = next();
    const path = rest();

    if (slug === undefined || !isOrgSlug(slug) || path === undefined) return undefined;

    // No orgs inside an org.
    return decodedLowercase(path.split("/")[0] ?? "") === ORGS_SEGMENT
      ? undefined
      : { slug, path: `${MANAGEMENT_PREFIX}/${path}` };
  }

  if (first === PANEL_ORG_PREFIX.slice(1)) {
    const slug = next();

    if (slug === undefined || !isOrgSlug(slug)) return undefined;
    const path = rest();

    if (path === undefined) return { slug, path: "/" };
    const section = decodedLowercase(path.split("/")[0] ?? "");

    return PANEL_SECTIONS.some((page) => page !== "assets" && page === section)
      ? { slug, path: `/${path}` }
      : undefined;
  }

  return undefined;
};

/**
 * The address of the org in a request URL (absolute or origin-relative), with the URL the request has once the org is
 * taken out: the path of {@link parseOrgAddress} and the query unchanged. `undefined` for a URL of no org.
 */
export const scopedUrl = (
  requestUrl: string,
): { readonly slug: OrgSlug; readonly url: string } | undefined => {
  let parsed: URL;

  try {
    parsed = new URL(requestUrl, "http://invalid.invalid");
  } catch {
    return undefined;
  }

  // The raw path: `URL` leaves the percent-encoding and the duplicate slashes of the request alone.
  const address = parseOrgAddress(parsed.pathname);

  return address === undefined
    ? undefined
    : { slug: address.slug, url: `${address.path}${parsed.search}` };
};

/** The path of a (normalised) path once its org is taken out: the page or API path the router matches. */
export const unscopedPath = (path: string): string => parseOrgAddress(path)?.path ?? path;

/**
 * Whether a normalised path (`normalizedPath`) is a page a browser may open from another site: the panel's pages
 * (not `/assets`), also those of an org (`/o/<slug>/accounts`), and the legacy panel address. The management API
 * (`/v9/management*`) never is.
 */
export const isPanelPagePath = (path: string): boolean => {
  const page = unscopedPath(path);

  return (
    page === "/" ||
    page === LEGACY_PANEL_PATH ||
    PANEL_SECTIONS.some((section) => section !== "assets" && inSection(page, section))
  );
};

/** Whether a request URL is one of the panel's bundle files (`/assets/*`), however it is spelled. */
export const isPanelAssetPath = (requestUrl: string): boolean => {
  const path = normalizedPath(requestUrl);

  return path !== undefined && inSection(path, "assets");
};

export type AccessZone = "public" | "protected" | "management";

/**
 * The path of a request URL, percent-decoded, with duplicate slashes collapsed and lowercased; `undefined` when the
 * URL cannot be parsed.
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
 * Classifies a request URL. Matching is deliberately a superset of what the router matches (percent-decoding,
 * duplicate slashes and case are normalised) so an unusual spelling of a protected path cannot reach a handler
 * unauthenticated; over-matching only turns a 404 into a 401.
 */
export const classifyPath = (requestUrl: string): AccessZone => {
  const path = normalizedPath(requestUrl);

  if (path === undefined) return "protected";

  if (path.startsWith(MANAGEMENT_PREFIX) || path.startsWith(LEGACY_PANEL_PATH) || isPanelPath(path))
    return "management";

  return PROTECTED_PREFIXES.some((prefix) => path.startsWith(prefix)) ? "protected" : "public";
};
