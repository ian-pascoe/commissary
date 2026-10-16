// The test Worker's bindings (vitest.config.ts) as `env` from `cloudflare:workers` types them: state's view of a
// Worker's env (`StateObjectEnv`), with the namespaces typed through the test Worker's classes.
interface __StateTestEnv extends Omit<
  import("../src/index.ts").StateObjectEnv,
  keyof import("../src/index.ts").StateBindings
> {
  CONTROL_PLANE: DurableObjectNamespace<import("./worker.ts").ControlPlane>;
  PLATFORM: DurableObjectNamespace<import("./worker.ts").Platform>;
  SESSION_STATE: DurableObjectNamespace<import("./worker.ts").SessionState>;
}

declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./worker.ts");
    durableNamespaces: "ControlPlane" | "SessionState" | "Platform";
  }

  interface Env extends __StateTestEnv {}
}
