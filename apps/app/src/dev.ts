// The app Worker's entry under `alchemy dev` only, never deployed (alchemy.run.ts picks it on its dev flag): the
// handler plus the state Worker's Durable Objects, bound locally. Locally a cross-script Durable Object is reached
// through the dev registry by its hex id, so `ctx.id.name`, which tells a ControlPlane its org, would be lost
// ([cloudflare/workerd#7286](https://github.com/cloudflare/workerd/issues/7286), docs/DEVELOPMENT.md
// "Infrastructure"). For the same reason it also exports the dev-only `DevStateBridge` entrypoint, through which the API
// Worker's dev entry (apps/api/src/dev.ts) reaches these same objects by name. Deployed, the app and the API Worker bind
// the state Worker's objects by script name.
export { default } from "./index.ts";

export { ControlPlane, Platform, SessionState } from "@commissary/state-worker";

export { DevStateBridge } from "@commissary/state/dev-state-bridge";
