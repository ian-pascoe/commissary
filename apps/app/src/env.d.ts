// Bindings and variables of the Worker. Deployed values come from `alchemy.run.ts` (the Worker's `env` plus the
// `ASSETS` binding created by `assets`); keep both in sync. Tests bind the same names in `vitest.config.ts`.
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
   * The app host (`COMMISSARY_DOMAIN`): panel, sign-in and management API. Set together with `API_DOMAIN`; unset,
   * like `API_DOMAIN`, on a deployment that serves everything on one host (src/http/hosts.ts, ADR 0028).
   */
  APP_DOMAIN?: string;
  /** The API host (`COMMISSARY_API_DOMAIN`): the only host of the client API. Unset: one host serves everything. */
  API_DOMAIN?: string;
  /** Overrides the Meta key-mint endpoint (empty: default). */
  META_MINT_URL: string;
  /**
   * Secret HMAC key of `auth_index` (src/management/auth-index.ts). Deployed: an Alchemy `Random` (alchemy.run.ts);
   * tests and `alchemy dev` use their own. Empty fails closed.
   */
  AUTH_INDEX_KEY: string;
  /**
   * Secrets key of the stage (src/secrets/): wraps every org's data key, which seals the stored secrets. Deployed: an
   * Alchemy `Random` per key generation (alchemy.run.ts); tests and `alchemy dev` use their own. Missing: no
   * ControlPlane starts.
   */
  SECRETS_KEY: string;
  /** During a rotation, the secrets key `SECRETS_KEY` replaces: data keys still wrapped by it are wrapped again. */
  SECRETS_KEY_PREVIOUS?: string;
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
  /** Hosted: the per-org request rate limit of the client API (Workers rate limiting, keyed by org id). */
  ORG_RATE_LIMIT?: RateLimit;
  CONTROL_PLANE: DurableObjectNamespace<import("./index").ControlPlane>;
  SESSION_STATE: DurableObjectNamespace<import("./index").SessionState>;
  /** The Platform registry: one object per deployment (`platformOf`, src/platform/registry.ts). */
  PLATFORM: DurableObjectNamespace<import("./index").Platform>;
}

declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./index");
    durableNamespaces: "ControlPlane" | "SessionState" | "Platform";
  }

  interface Env extends __BaseEnv_Env {}
}

interface Env extends __BaseEnv_Env {}

// Non-JavaScript modules (Workers module rules; `*.bin` is in src/tokenizer/bin.d.ts).
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
