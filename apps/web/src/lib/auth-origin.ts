// Where the sign-in page and the sign-out send their requests on Commissary Cloud (ADR 0030): the auth host, whose origin
// the app Worker names in the page (`<meta name="commissary-auth-origin">`, apps/app/src/management/web-panel.ts). Without
// it (a self-hosted Commissary never shows these pages; the panel's dev server) they go to the page's own origin.
// Pure: no DOM (the page's tag is read by src/auth-origin.ts), tested in test/auth-origin.test.ts.

/** The `<meta>` tag naming the auth host's origin. */
export const AUTH_ORIGIN_META = "commissary-auth-origin";

/** The auth host's origin of a `<meta>` tag's content; `""` (the page's own origin) unless it is an http(s) origin. */
export const authOriginOf = (content: string | null | undefined): string => {
  const value = content?.trim() ?? "";

  try {
    const url = new URL(value);

    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value
      ? url.origin
      : "";
  } catch {
    return "";
  }
};

/** `path` on the auth host (`origin`, `""` for the page's own origin). */
export const authUrl = (origin: string, path: string): string => `${origin}${path}`;

/**
 * Where a sign-in started on the auth host returns: `next` (a path of the panel, `safeNextPath`) on the page's origin
 * `appOrigin`, absolute so the auth host does not read it as one of its own.
 */
export const returnUrl = (appOrigin: string, next: string): string => `${appOrigin}${next}`;
