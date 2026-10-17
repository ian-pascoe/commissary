// The auth host the page names (`<meta name="commissary-auth-origin">`, src/lib/auth-origin.ts), read from the
// document: the sign-in page and the sign-out send their requests there.
import { AUTH_ORIGIN_META } from "@commissary/contract/sign-in";
import { authOriginOf } from "./lib/auth-origin.ts";

/** `path` on the auth host the page names; on the page's own origin without one. */
export const onAuthHost = (path: string): string =>
  `${authOriginOf(
    document.querySelector<HTMLMetaElement>(`meta[name="${AUTH_ORIGIN_META}"]`)?.content,
  )}${path}`;
