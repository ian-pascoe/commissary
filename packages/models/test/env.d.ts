// The test Worker's bindings (vitest.config.ts) as `env` from `cloudflare:workers` types them: what Models reads
// (`ModelsBindings`), what state's Durable Object classes read (`StateObjectEnv`) and what the client API harness's gate
// reads (`AuthBindings`), with the namespaces typed through the test Worker's classes (test/worker.ts).
interface __ModelsTestEnv {
  CACHE: KVNamespace;
  USAGE: D1Database;
  CONTROL_PLANE: DurableObjectNamespace<import("./worker.ts").ControlPlane>;
  PLATFORM: DurableObjectNamespace<import("./worker.ts").Platform>;
  SESSION_STATE: DurableObjectNamespace<import("./worker.ts").SessionState>;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  PLATFORM_ADMIN_EMAILS: string;
  PLATFORM_ADMIN_SERVICE_TOKENS: string;
  ACCESS_DEV_BYPASS: string;
  COMMISSARY_MODE?: string;
  META_MINT_URL: string;
  AUTH_INDEX_KEY: string;
  SECRETS_KEY: string;
  SECRETS_KEY_PREVIOUS?: string;
}

declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./worker.ts");
    durableNamespaces: "ControlPlane" | "SessionState" | "Platform";
  }

  interface Env extends __ModelsTestEnv {}
}
