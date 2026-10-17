// The state Worker's entry under `alchemy dev` only, never deployed (alchemy.run.ts picks it on its dev flag): its
// Durable Objects plus the dev-only `DevStateBridge` entrypoint. Locally a cross-script Durable Object is reached
// through the dev registry by its hex id, which drops `ctx.id.name`, the name a ControlPlane learns its org from
// ([cloudflare/workerd#7286](https://github.com/cloudflare/workerd/issues/7286), docs/DEVELOPMENT.md
// "Infrastructure"). So under `alchemy dev` the app, API and auth Workers bind this entrypoint as a service instead of
// the namespaces, and it replays their calls on its own stubs, where the name survives
// (`@commissary/state/dev-state-bridge`). Deployed, they bind the namespaces by script name and this entry is unused.
export * from "./index.ts";

export { default } from "./index.ts";

export { DevStateBridge } from "@commissary/state/dev-state-bridge";
