/**
 * The one function of `tldts` that Better Auth's SSO plugin calls, `getHostname`, in place of the package
 * (`infra/bundle.ts` aliases it): the plugin only reads the host name of a provider's domain, which needs no public
 * suffix list, and the list is a quarter of a megabyte the Workers would otherwise compile at every startup. Both the
 * auth Worker (sign-in) and the app Worker (setting up a provider, apps/app/src/sso/idp.ts) bundle the plugin.
 *
 * Commissary hands the plugin verified domains only (`@commissary/auth/sso` `provider.ts`), already DNS names.
 */

/** The host name of `input`, a URL or a bare host name; `null` when it has none. */
export const getHostname = (input: string): string | null => {
  const value = input.trim();

  if (value === "") return null;

  try {
    const { hostname } = new URL(value.includes("://") ? value : `https://${value}`);

    return hostname === "" ? null : hostname;
  } catch {
    return null;
  }
};
