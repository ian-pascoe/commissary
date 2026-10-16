// The test Worker's bindings (vitest.config.ts) as `env` from `cloudflare:workers` types them: state's view of a
// Worker's env (`StateObjectEnv`), with the namespaces typed through the test Worker's classes.
interface __StateTestEnv {
  CONTROL_PLANE: DurableObjectNamespace<import("./worker").ControlPlane>;
  PLATFORM: DurableObjectNamespace<import("./worker").Platform>;
  SESSION_STATE: DurableObjectNamespace<import("./worker").SessionState>;
  COMMISSARY_MODE?: string;
  PLATFORM_ADMIN_EMAILS: string;
  PLATFORM_ADMIN_SERVICE_TOKENS: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  SECRETS_KEY: string;
  SECRETS_KEY_PREVIOUS?: string;
}

declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./worker");
    durableNamespaces: "ControlPlane" | "SessionState" | "Platform";
  }

  interface Env extends __StateTestEnv {}
}
