/**
 * Sign-in on a hosted proxy (ADR 0026, `src/hosted/`): what the panel's sign-in page needs before anyone is signed in.
 * Outside `/v9/management` (no caller yet), so not part of `ManagementApi`. Workers addition, no Go counterpart. Shared
 * with the browser: imports `effect` only.
 */
import { Schema } from "effect";

/** The public address of {@link SignInOptions}; a self-hosted proxy answers it with 404. */
export const SIGN_IN_OPTIONS_PATH = "/api/sign-in-options";

/** The panel's sign-in page on a hosted proxy. */
export const SIGN_IN_PAGE_PATH = "/sign-in";

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
