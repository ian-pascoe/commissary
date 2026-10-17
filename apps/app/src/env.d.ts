// Bindings and variables of the Worker. Deployed values come from `alchemy.run.ts` (the Worker's `env` plus the
// `ASSETS` binding created by `assets`); keep both in sync. Tests bind the same names in `vitest.config.ts`. The Durable
// Object namespaces are the state Worker's (apps/state), bound by script name; what its classes read is in its own
// `env` too (apps/state/src/env.d.ts).
// `Env` is read only by the entry (`index.ts`) and tests; other code
// reads its package's view (`AuthConfig`, `StateEnv`, `ModelsEnv`, `AppEnv`: `worker-env.ts`), which `Env` must satisfy.
interface __BaseEnv_Env {
  /** Model catalogs, signature cache, Antigravity state (Workers KV). */
  CACHE: KVNamespace;
  /** Usage records and, on Commissary Cloud, Better Auth's people and sessions (D1); schema in migrations/. */
  USAGE: D1Database;
  /** Static assets (management panel). */
  ASSETS: Fetcher;
  /** Access team name or domain (`myteam`, `myteam.cloudflareaccess.com`); empty fails closed. */
  ACCESS_TEAM_DOMAIN: string;
  /** Comma separated Access application AUD tags; empty fails closed. */
  ACCESS_AUD: string;
  /** Comma separated platform admin emails: manage every org and the Platform registry (ADR 0022). */
  PLATFORM_ADMIN_EMAILS: string;
  /** Comma separated platform admin service token Client IDs. */
  PLATFORM_ADMIN_SERVICE_TOKENS: string;
  /** Local development only: treats loopback requests as this admin. Never set when deployed. */
  ACCESS_DEV_BYPASS: string;
  /**
   * The host the API Worker serves the client API on (src/http/hosts.ts, ADR 0028, ADR 0030): the API host
   * (`COMMISSARY_API_DOMAIN`), or a preview API Worker's workers.dev host. Unset: zone routes send the client API paths
   * on the app host to the API Worker.
   */
  API_DOMAIN?: string;
  /** Overrides the Meta key-mint endpoint (empty: default). */
  META_MINT_URL: string;
  /**
   * Secret HMAC key of `auth_index` (packages/models/src/management/auth-index.ts). Deployed: an Alchemy `Random` (alchemy.run.ts);
   * tests and `alchemy dev` use their own. Empty fails closed.
   */
  AUTH_INDEX_KEY: string;
  /**
   * `cloud`: Commissary Cloud (ADR 0026, src/hosted/): the Worker signs people in with Better Auth and Access is not
   * used; unset or `self-hosted`: Cloudflare Access in front of the panel and the management API (ADR 0022).
   */
  COMMISSARY_MODE?: string;
  /** Hosted: Better Auth's signing secret. Deployed: an Alchemy `Random` (alchemy.run.ts). */
  BETTER_AUTH_SECRET?: string;
  /** Hosted: the GitHub OAuth app; GitHub sign-in is offered when both are set. */
  SIGN_IN_GITHUB_CLIENT_ID?: string;
  SIGN_IN_GITHUB_CLIENT_SECRET?: string;
  /** Hosted: the Google OAuth client; Google sign-in is offered when both are set. */
  SIGN_IN_GOOGLE_CLIENT_ID?: string;
  SIGN_IN_GOOGLE_CLIENT_SECRET?: string;
  /** Hosted: Cloudflare Turnstile widget keys guarding sign-in and sign-up. */
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  /** Hosted: how many orgs a person may own unless a platform admin raised their limit (default 3). */
  OWNED_ORG_LIMIT?: string;
  CONTROL_PLANE: DurableObjectNamespace<import("@commissary/state-worker").ControlPlane>;
  SESSION_STATE: DurableObjectNamespace<import("@commissary/state-worker").SessionState>;
  /** The Platform registry: one object per deployment (`platformOf`, `@commissary/state`). */
  PLATFORM: DurableObjectNamespace<import("@commissary/state-worker").Platform>;
}

declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./index");
  }

  interface Env extends __BaseEnv_Env {}
}

interface Env extends __BaseEnv_Env {}

// Non-JavaScript modules (Workers module rules).
// @commissary/translation's tokenizer ranks: `Data` modules (alchemy.run.ts and vitest.config.ts `modulesRules`).
declare module "*.bin" {
  const data: ArrayBuffer;
  export default data;
}

declare module "*.txt" {
  const value: string;
  export default value;
}

declare module "*.html" {
  const value: string;
  export default value;
}

declare module "*.sql" {
  const value: string;
  export default value;
}
