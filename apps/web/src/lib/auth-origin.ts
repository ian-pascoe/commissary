// Where the sign-in page and the sign-out send their requests on Commissary Cloud (ADR 0030): the auth host, whose origin
// the app Worker names in the page (`<meta name="commissary-auth-origin">`, apps/app/src/management/web-panel.ts). Without
// it (a self-hosted Commissary never shows these pages; the panel's dev server) they go to the page's own origin.
// Pure: no DOM (the page's tag is read by src/auth-origin.ts), tested in test/auth-origin.test.ts.
import { httpOrigin } from "@commissary/contract/sign-in";

/** The auth host's origin of a `<meta>` tag's content; `""` (the page's own origin) unless it is an http(s) origin. */
export const authOriginOf = (content: string | null | undefined): string =>
  httpOrigin(content) ?? "";
