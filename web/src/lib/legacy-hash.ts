// Bookmarks of the upstream panel. It was a HashRouter app at `/management.html` (`#/auth-files`, `#/quota`, ...);
// the Worker now redirects that path to `/` (src/management/web-panel.ts `LEGACY_PANEL_REDIRECT`) and the browser
// keeps the fragment, so `/#/auth-files` reaches the panel. `legacyHashTarget` names the page that replaced the old
// one (routes of Cli-Proxy-API-Management-Center src/router/MainRoutes.tsx); the router applies it on boot.

/** Upstream route (lower-cased, no trailing slash) to the panel page that replaced it. */
const TARGETS: ReadonlyArray<readonly [prefix: string, target: string]> = [
  ["/auth-files/oauth-excluded", "/models/rules"],
  ["/auth-files/oauth-model-alias", "/models/rules"],
  ["/auth-files", "/accounts"],
  ["/quota", "/accounts"],
  ["/oauth", "/accounts/connect"],
  ["/ai-providers", "/keys"],
  ["/quick-start", "/keys"],
  // Upstream sends `/settings` to its config page, and `/api-keys` (the keys clients send) to the config page too; the
  // panel's own API keys page replaces that one.
  ["/config", "/settings"],
  ["/settings", "/settings"],
  ["/api-keys", "/api-keys"],
  // Version and runtime facts live on Settings.
  ["/system", "/settings"],
];

/**
 * The panel path for an upstream panel fragment (`#/auth-files`, `#/ai-providers/claude`, `#/config?x=1`): its
 * replacement page, or `/` for one without a replacement (dashboard, logs, plugins, unknown). `undefined` when the
 * fragment is not an upstream route (no `#/`), so the panel's own fragments are left alone.
 */
export const legacyHashTarget = (hash: string): string | undefined => {
  if (!hash.startsWith("#/")) return undefined;
  const path = (hash.slice(1).split(/[?#]/)[0] ?? "").toLowerCase().replace(/\/+$/, "");

  const match = TARGETS.find(([prefix]) => path === prefix || path.startsWith(`${prefix}/`));

  return match?.[1] ?? "/";
};
