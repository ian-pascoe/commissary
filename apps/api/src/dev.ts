// The API Worker's entry under `alchemy dev` only, never deployed (alchemy.run.ts picks it on its dev flag). Locally a
// cross-script Durable Object is reached through the dev registry by its hex id, which drops `ctx.id.name`, the name a
// ControlPlane learns its org from ([cloudflare/workerd#7286](https://github.com/cloudflare/workerd/issues/7286),
// docs/DEVELOPMENT.md "Infrastructure"). So under `alchemy dev` the app Worker hosts the Durable Objects
// (apps/app/src/dev.ts), and this entry reaches them through the app Worker's dev-only `DevStateBridge` entrypoint
// (`DEV_STATE_BRIDGE`): the state namespaces are replaced with bridged ones, whose stubs send their calls, with the
// object's name, over that service binding (`@commissary/state/dev-state-bridge`). Deployed, the API Worker binds the
// state Worker's objects by script name and runs src/index.ts.
import { type DevBridgedEnv, devBridgedNamespace } from "@commissary/state/dev-state-bridge";
import { api } from "./index.ts";

const bridged = new WeakMap<DevBridgedEnv<Env>, Env>();

/** `env` with the state namespaces over the bridge; the same copy for the same `env`, so caches keyed by it keep working. */
const bridgedEnv = (env: DevBridgedEnv<Env>): Env => {
  const known = bridged.get(env);

  if (known !== undefined) return known;
  const bridge = env.DEV_STATE_BRIDGE;

  const copy: Env = {
    ...env,
    CONTROL_PLANE: devBridgedNamespace(bridge, "CONTROL_PLANE"),
    PLATFORM: devBridgedNamespace(bridge, "PLATFORM"),
    SESSION_STATE: devBridgedNamespace(bridge, "SESSION_STATE"),
  };

  bridged.set(env, copy);

  return copy;
};

export default {
  fetch: (request, env, ctx) => api.fetch(request, bridgedEnv(env), ctx),
  scheduled: (controller, env, ctx) => api.scheduled(controller, bridgedEnv(env), ctx),
} satisfies ExportedHandler<DevBridgedEnv<Env>>;
