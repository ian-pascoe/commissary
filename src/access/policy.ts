/**
 * The role a request needs (ADR 0022, the permission matrix of `docs/ACCESS.md`). New in the Workers port, no Go
 * counterpart: Go has one management key for everything.
 *
 * - **platform-level**: needs no role in any org: who the caller is (`/v8/management/me`), the org list
 *   (`/v8/management/orgs`, `/v8/management/orgs/<slug>`; their handlers ask for a platform admin), the panel's pages
 *   without an org (they redirect to an org of the caller or show the org chooser), its bundle files and the old
 *   panel's address.
 * - **member**: any role in the org: the proxy routes, the panel's pages of the org, and reading usage (a plain member
 *   sees only their own requests, `management/usage-routes.ts`).
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
];

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

  const reading = method === "GET" || method === "HEAD";

  return reading && MEMBER_READS.includes(route) ? "member" : "admin";
};
