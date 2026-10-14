/**
 * The role a request needs (ADR 0022, the permission matrix of `docs/ACCESS.md`). New in the Workers port, no Go
 * counterpart: Go has one management key for everything.
 *
 * - **platform-level**: needs no role in any org: who the caller is (`/v8/management/me`), the org list
 *   (`/v8/management/orgs`, `/v8/management/orgs/<slug>`; their handlers ask for a platform admin), the panel's pages
 *   without an org (they redirect to an org of the caller or show the org chooser), its bundle files and the old
 *   panel's address.
 * - **member**: any role in the org: the proxy routes, the panel's pages of the org, reading usage (a plain member
 *   sees only their own requests, `management/usage-routes.ts`) and their own proxy keys
 *   (`management/proxy-key-routes.ts`).
 * - **admin**: everything else of the management API. Some routes need more and say so in their handler: changing a
 *   role (org owner), downloading a credential or giving a service token a role above member (ADR 0006's rule per
 *   org, `members/roles.ts` `holdsSensitivePowers`).
 */
import type { OrgRole } from "../members/roles.ts";
import {
  type AccessZone,
  isPanelPagePath,
  LEGACY_PANEL_PATH,
  MANAGEMENT_PREFIX,
  normalizedPath,
  ORGS_SEGMENT,
  parseOrgAddress,
} from "./routes.ts";

export type RouteAccess = "platform" | OrgRole;

/** Management API routes a plain member may use (`GET` only), after the org is taken out of the path. */
const MEMBER_READS = [
  `${MANAGEMENT_PREFIX}/observability/usage/records`,
  `${MANAGEMENT_PREFIX}/observability/usage/summary`,
  `${MANAGEMENT_PREFIX}/observability/usage/series`,
  // The models the caller may use (ADR 0023): the registry as their own grants leave it.
  `${MANAGEMENT_PREFIX}/models/mine`,
];

/**
 * Management API routes a plain member may use besides the reads above: connecting and managing their own private
 * credentials (ADR 0023). Their handlers scope every operation to what the caller reaches, so a plain member never sees
 * or changes a shared credential, nor another member's private one (`credentials/ownership.ts`).
 */
const CREDENTIAL = `${MANAGEMENT_PREFIX}/credentials`;

const API_KEYS = `${MANAGEMENT_PREFIX}/api-keys`;

const MEMBER_CREDENTIAL_ROUTES: ReadonlyArray<{
  readonly methods: ReadonlyArray<string>;
  readonly path: string;
}> = [
  { methods: ["GET", "POST", "DELETE"], path: CREDENTIAL },
  { methods: ["GET"], path: `${CREDENTIAL}/download` },
  { methods: ["GET"], path: `${CREDENTIAL}/models` },
  { methods: ["PATCH"], path: `${CREDENTIAL}/status` },
  { methods: ["PATCH"], path: `${CREDENTIAL}/fields` },
  { methods: ["POST"], path: `${CREDENTIAL}/refresh` },
  { methods: ["POST"], path: `${CREDENTIAL}/batch` },
  { methods: ["POST"], path: `${CREDENTIAL}/quota` },
  { methods: ["POST"], path: `${CREDENTIAL}/quota/all` },
  { methods: ["GET"], path: `${CREDENTIAL}/reset-grants` },
  { methods: ["POST"], path: `${CREDENTIAL}/reset-grants/claim` },
  { methods: ["POST"], path: `${MANAGEMENT_PREFIX}/routing/cooldown/reset` },
  { methods: ["GET"], path: `${MANAGEMENT_PREFIX}/oauth/auth-url` },
  { methods: ["GET"], path: `${MANAGEMENT_PREFIX}/oauth/status` },
  { methods: ["DELETE"], path: `${MANAGEMENT_PREFIX}/oauth/session` },
  { methods: ["POST"], path: `${MANAGEMENT_PREFIX}/oauth/callback` },
  { methods: ["POST"], path: `${MANAGEMENT_PREFIX}/oauth/import` },
  { methods: ["GET"], path: API_KEYS },
  { methods: ["PUT", "DELETE"], path: `${API_KEYS}/groups` },
  { methods: ["POST"], path: `${API_KEYS}/probe` },
];

/** A member's own proxy keys (`management/proxy-key-routes.ts`, which limits a plain member to their keys). */
const PROXY_KEYS = `${MANAGEMENT_PREFIX}/proxy-keys`;

/**
 * Spend limits (`management/spend-routes.ts`): a plain member reads the limits that bind them and limits their own proxy
 * keys, so those routes are for members; the calendar (`/spend/settings`) stays for org admins.
 */
const SPEND = `${MANAGEMENT_PREFIX}/spend`;

const SPEND_SETTINGS = `${SPEND}/settings`;

const ME = `${MANAGEMENT_PREFIX}/me`;

const ORGS = `${MANAGEMENT_PREFIX}/${ORGS_SEGMENT}`;

const withoutTrailingSlash = (path: string): string =>
  path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;

/**
 * What a request to `requestUrl` in `zone` needs. Paths are compared like the zones are classified (`normalizedPath`:
 * percent-decoded, duplicate slashes collapsed, lowercased), so an unusual spelling never needs less than the route it
 * reaches.
 */
export const routeAccess = (
  method: string,
  requestUrl: string,
  zone: Exclude<AccessZone, "public">,
): RouteAccess => {
  if (zone === "protected") return "member";
  const path = normalizedPath(requestUrl);

  if (path === undefined) return "admin";
  const address = parseOrgAddress(path);
  const route = withoutTrailingSlash(address?.path ?? path);

  if (route === ME) return "platform";

  if (address === undefined) {
    if (route === ORGS || route.startsWith(`${ORGS}/`)) return "platform";

    if (route === "/assets" || route.startsWith("/assets/") || route.startsWith(LEGACY_PANEL_PATH))
      return "platform";

    if (isPanelPagePath(route)) return "platform";
  } else if (isPanelPagePath(route)) return "member";

  if (route === PROXY_KEYS || route.startsWith(`${PROXY_KEYS}/`)) return "member";

  if ((route === SPEND || route.startsWith(`${SPEND}/`)) && route !== SPEND_SETTINGS)
    return "member";
  const reading = method === "GET" || method === "HEAD";

  if (reading && MEMBER_READS.includes(route)) return "member";

  return MEMBER_CREDENTIAL_ROUTES.some(
    (entry) => entry.path === route && entry.methods.includes(method),
  )
    ? "member"
    : "admin";
};
