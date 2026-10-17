// The auth host's origin the page names (`<meta name="commissary-auth-origin">`, src/lib/auth-origin.ts), read from the
// document: the sign-in page and the sign-out send their requests there.
import { AUTH_ORIGIN_META, authOriginOf } from "./lib/auth-origin.ts";

/** The auth host's origin the page names; `""` (the page's own origin) without one. */
export const authOrigin = (): string =>
  authOriginOf(
    document.querySelector<HTMLMetaElement>(`meta[name="${AUTH_ORIGIN_META}"]`)?.content,
  );
