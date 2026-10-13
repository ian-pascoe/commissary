// Which org the panel is showing (ADR 0021). The panel of an org lives under `/o/<slug>/...` and calls the org's
// management routes `/v8/management/orgs/<slug>/...`; the address without an org (`/`, `/accounts`) is the chooser, or
// a redirect to the caller's only org (src/management/web-panel.ts). Pure helpers, shared by the router and the client.

import { MANAGEMENT_API_PREFIX } from "#contract/api.ts";

/** The management prefix; below it `/orgs...` is platform-level and every other route exists per org (`/me` too). */
const API = MANAGEMENT_API_PREFIX;

const PANEL_ORG = /^\/o\/([^/]+)(?=\/|$)/i;

/** The org slug of a panel path (`/o/acme/accounts` is `acme`), lower-cased; `undefined` for an address without one. */
export const orgSlugOfPath = (pathname: string): string | undefined => {
  const slug = PANEL_ORG.exec(pathname)?.[1];

  if (slug === undefined) return undefined;

  try {
    return decodeURIComponent(slug).toLowerCase();
  } catch {
    // A bad escape names no org: the server answers it with 404 before the panel loads.
    return slug.toLowerCase();
  }
};

/** The router's base path for a panel path: `/o/acme` for `/o/acme/accounts`, `/` for an address without an org. */
export const panelBasepath = (pathname: string): string => {
  const slug = orgSlugOfPath(pathname);

  return slug === undefined ? "/" : `/o/${encodeURIComponent(slug)}`;
};

/** The panel address of a page of an org: `orgPanelPath("acme", "/accounts")` is `/o/acme/accounts`. */
export const orgPanelPath = (slug: string, page = "/"): string =>
  `/o/${encodeURIComponent(slug)}${page}`;

// `/me` is not among them: addressed to an org it answers the caller's role in that org.
const isPlatformLevel = (rest: string): boolean => /^\/orgs(?=[/?#]|$)/.test(rest);

/**
 * `url` (an absolute URL or a path of the management API) addressed to the org `slug`: `/v8/management/credentials`
 * becomes `/v8/management/orgs/acme/credentials`.
 * `/me` is scoped too (it then answers the caller's role in the org). The platform-level routes (`/orgs`,
 * `/orgs/:slug`) and any other URL stay as they are.
 */
export const scopedApiUrl = (url: string, slug: string | undefined): string => {
  if (slug === undefined) return url;

  const at = url.indexOf(`${API}/`);

  if (at < 0) return url;

  const split = at + API.length;

  if (isPlatformLevel(url.slice(split))) return url;

  return `${url.slice(0, split)}/orgs/${encodeURIComponent(slug)}${url.slice(split)}`;
};
