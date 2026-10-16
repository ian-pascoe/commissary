// Which org the panel is showing (ADR 0021). The panel of an org lives under `/o/<slug>/...` and calls the org's
// management routes `/v9/management/orgs/<slug>/...`; the address without an org (`/`, `/accounts`) is the chooser, or
// a redirect to the caller's only org (apps/app/src/management/web-panel.ts). Pure helpers, shared by the router and
// the client.

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
