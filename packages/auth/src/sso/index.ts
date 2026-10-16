/**
 * `@commissary/auth/sso`: per-org single sign-on as a sign-in needs it (issue #76): how an email domain is written and
 * proved (`domain.ts`, also used by the browser), an org's identity provider settings (`settings.ts`), and the provider
 * Better Auth's SSO plugin is given (`provider.ts`).
 */
export * from "./domain.ts";

export * from "./provider.ts";

export * from "./settings.ts";
