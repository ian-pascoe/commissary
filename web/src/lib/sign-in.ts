// The sign-in page's pure helpers (Commissary Cloud, ADR 0026): where to go after signing in and what a failed attempt
// says. Pure: no DOM, tested in test/web-sign-in.test.ts.
import { SIGN_IN_PAGE_PATH, type SignInProvider } from "#contract/sign-in.ts";

const hasControl = (text: string): boolean =>
  Array.from(text).some((character) => {
    const code = character.codePointAt(0) ?? 0;

    return code < 0x20 || code === 0x7f;
  });

/**
 * The page to open after signing in: the `next` query parameter when it is a path of this origin (starts with one `/`,
 * no `//`, no backslash, no control character, not the sign-in page itself), else the panel's root.
 */
export const safeNextPath = (next: string | null | undefined): string => {
  if (next === null || next === undefined) return "/";

  if (!next.startsWith("/") || next.startsWith("//") || next.includes("\\") || hasControl(next))
    return "/";

  if (next === SIGN_IN_PAGE_PATH || next.startsWith(`${SIGN_IN_PAGE_PATH}?`)) return "/";

  return next;
};

const PROVIDER_LABELS: Readonly<Record<SignInProvider, string>> = {
  github: "GitHub",
  google: "Google",
};

export const providerLabel = (provider: SignInProvider): string => PROVIDER_LABELS[provider];

/** Whether the `?error=` code is a refused GitHub or Google sign-in that steers the person to the work email form. */
export const needsWorkEmail = (code: string | null | undefined): boolean =>
  code?.trim().toLowerCase() === "sso_required";

/** What Better Auth's `?error=` code of a failed sign-in means, in plain words. */
export const signInProblem = (code: string | null | undefined): string | undefined => {
  if (code === null || code === undefined || code.trim() === "") return undefined;

  switch (code.trim().toLowerCase()) {
    case "email_not_verified":
    case "unverified_email":
      return "Your email address is not verified with that provider. Verify it there, or sign in with another provider.";
    case "access_denied":
      return "The provider did not let us sign you in: access was denied. Try again and allow access.";
    case "account_not_linked":
      return "An account with this email already exists through another provider. Sign in with the provider you used first.";
    case "banned":
    case "user_banned":
      return "This account is suspended. Ask the person who runs this Commissary.";
    case "signup_disabled":
      return "New accounts are not accepted on this Commissary.";
    case "sso_required":
      return "Your organization requires you to sign in with your work email. Enter it below.";
    case "sso_removed":
      return "An admin removed you from this organization. Ask them to add you again, then sign in with your work email.";
    case "sso_domain_unverified":
      return "Your organization has not verified your email’s domain. Ask an org owner to verify it, then try again.";
    case "sso_unavailable":
      return "Single sign-on is not available for your organization right now. Ask an org owner to check its identity provider.";
    case "invalid_captcha":
    case "captcha_failed":
      return "The bot check failed. Try again.";
    default:
      return "Sign-in failed. Try again, or use another provider.";
  }
};

/** What a refused `POST` to the sign-in route says, by status. */
export const signInRequestProblem = (status: number): string => {
  if (status === 403) return "The bot check failed or has expired. Try again.";

  if (status === 429) return "Too many attempts. Wait a minute and try again.";

  return "Could not start the sign-in. Try again.";
};
