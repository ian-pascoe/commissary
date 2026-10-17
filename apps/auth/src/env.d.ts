// Bindings and variables of the auth Worker (ADR 0030), deployed on Commissary Cloud only. Deployed values come from the
// `Auth` Worker's `env` in `alchemy.run.ts`; keep both in sync. Tests bind the same names in `vitest.config.ts`. The
// Durable Object namespaces are the state Worker's (apps/state), bound by script name; under `alchemy dev` they come
// over the state Worker's dev-only bridge instead (src/dev.ts). `Env` is read only by the entries (`index.ts`,
// `dev.ts`) and tests; other code reads its view (`AuthWorkerEnv`, `worker-env.ts`), which `Env` must satisfy.
interface __AuthWorkerEnv {
  /** Better Auth's people, sessions and linked accounts (D1, the `SignIn` database); schema in migrations/sign-in/. */
  SIGN_IN: D1Database;
  /**
   * The app host's origin (`https://<COMMISSARY_APP_DOMAIN>`, a preview's app workers.dev URL, the app's dev URL): where
   * the sign-in page and the panel are. The only origin CORS and Better Auth trust, the Turnstile widget's host, and
   * where a sign-in returns.
   */
  APP_ORIGIN: string;
  /**
   * The session cookie's `Domain` (the base domain, `COMMISSARY_DOMAIN`, ADR 0031; a preview's account workers.dev
   * subdomain), so the app host under it receives it. Empty under `alchemy dev`: a host-only `localhost` cookie spans
   * the ports.
   */
  AUTH_COOKIE_DOMAIN: string;
  /**
   * Better Auth's cookie prefix: one per preview stage, so previews keep apart; `commissary` once the base domain is
   * above the app host (ADR 0031); empty for Better Auth's default.
   */
  AUTH_COOKIE_PREFIX: string;
  /** Better Auth's signing secret. Deployed: an Alchemy `Random` (alchemy.run.ts). */
  BETTER_AUTH_SECRET?: string;
  /** The GitHub OAuth app; GitHub sign-in is offered when both are set. */
  SIGN_IN_GITHUB_CLIENT_ID?: string;
  SIGN_IN_GITHUB_CLIENT_SECRET?: string;
  /** The Google OAuth client; Google sign-in is offered when both are set. */
  SIGN_IN_GOOGLE_CLIENT_ID?: string;
  SIGN_IN_GOOGLE_CLIENT_SECRET?: string;
  /** Cloudflare Turnstile widget keys guarding sign-in and sign-up (the widget renders on the app host). */
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  CONTROL_PLANE: DurableObjectNamespace<import("@commissary/state-worker").ControlPlane>;
  SESSION_STATE: DurableObjectNamespace<import("@commissary/state-worker").SessionState>;
  /** The Platform registry: one object per deployment (`platformOf`, `@commissary/state`). */
  PLATFORM: DurableObjectNamespace<import("@commissary/state-worker").Platform>;
  // Not here on purpose: `DEV_STATE_BRIDGE`, bound under `alchemy dev` only (alchemy.run.ts) and typed by the dev entry
  // alone (`DevBridgedEnv`, src/dev.ts), so no deployed code can name it; the tests bind the objects instead.
}

declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./index");
  }

  interface Env extends __AuthWorkerEnv {}
}

interface Env extends __AuthWorkerEnv {}
