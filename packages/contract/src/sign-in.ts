/**
 * Sign-in on Commissary Cloud (ADR 0026, ADR 0030; the auth Worker, `apps/auth`): what the panel's sign-in page needs
 * before anyone is signed in. Outside `/v9/management` (no caller yet), so not part of `ManagementApi`. Workers addition, no Go
 * counterpart. Shared with the browser: imports `effect` only.
 */
import { Schema } from "effect";

/**
 * The `<meta>` tag the app Worker writes into the panel on Commissary Cloud, naming the auth host's origin: where the
 * sign-in page and the sign-out send their requests.
 */
export const AUTH_ORIGIN_META = "commissary-auth-origin";

// The WHATWG `URL` both runtimes (browser and workerd) have; the contract is checked without either's globals.
declare const URL: new (url: string) => { readonly protocol: string; readonly origin: string };

/** `value`, trimmed, when it is an http(s) origin (`https://auth.example.com`: no path, no trailing slash). */
export const httpOrigin = (value: string | null | undefined): string | undefined => {
  const trimmed = value?.trim() ?? "";

  try {
    const url = new URL(trimmed);

    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === trimmed
      ? url.origin
      : undefined;
  } catch {
    return undefined;
  }
};

/** The public address of {@link SignInOptions}; a self-hosted Commissary answers it with 404. */
export const SIGN_IN_OPTIONS_PATH = "/api/sign-in-options";

/** The panel's sign-in page on Commissary Cloud. */
export const SIGN_IN_PAGE_PATH = "/sign-in";

/** Where Better Auth's routes live; the auth Worker lets through only the paths it uses (`http/sign-in-routes.ts`). */
export const AUTH_BASE_PATH = "/api/auth";

/** Better Auth's routes the panel calls (the Worker refuses the rest of Better Auth's API). */
export const AUTH_ROUTES = {
  /** `POST {provider, callbackURL}` with the Turnstile token in `x-captcha-response`: `{url}` to send the browser to. */
  signInSocial: "/api/auth/sign-in/social",
  /**
   * `POST {email}` with the Turnstile token: `{url}` of the identity provider of the org that verified the email's
   * domain (issue #76); `404 sso_not_found` when no org did.
   */
  signInSso: "/api/auth/sign-in/sso",
  /** `GET`: `{user: {email, name, image}, session}` or `null`. */
  session: "/api/auth/get-session",
  /** `POST {}`: ends the session. */
  signOut: "/api/auth/sign-out",
} as const;

export const SignInProvider = Schema.Literals(["github", "google"]);

export type SignInProvider = typeof SignInProvider.Type;

/** `GET /api/sign-in-options`: the providers the deployment enabled and the Turnstile widget's site key. */
export const SignInOptions = Schema.Struct({
  providers: Schema.Array(SignInProvider),
  turnstile_site_key: Schema.String,
});

export type SignInOptions = typeof SignInOptions.Type;
