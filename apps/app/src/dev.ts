// The app Worker's entry under `alchemy dev` only, never deployed (alchemy.run.ts picks it on its dev flag): the
// handler plus the state Worker's Durable Objects, bound locally. Locally a cross-script Durable Object is reached
// through the dev registry by its hex id, so `ctx.id.name`, which tells a ControlPlane its org, would be lost
// (docs/DEVELOPMENT.md, "Infrastructure"). Deployed, the app binds the state Worker's objects by script name.
export { default } from "./index.ts";

export { ControlPlane, Platform, SessionState } from "@commissary/state-worker";
