// The test Worker's entry (vitest.config.ts, project `models`): a test-only ControlPlane, `@commissary/state`'s
// org-wide base composed with the Models part the way a Worker composes it (`composeControlPlane`, #135), the Platform
// registry and SessionState, on real SQLite storage. Models' tests depend on no other area and on no app.
import { composeControlPlane } from "@commissary/state";
import { ModelsPart, type ModelsPartEnv } from "../src/state.ts";

export { Platform, SessionState } from "@commissary/state";

export class ControlPlane extends composeControlPlane({
  models: (ctx, env: ModelsPartEnv, core) => new ModelsPart(ctx, env, core),
}) {}

export default {
  fetch: () => new Response("Models' test Worker serves no requests", { status: 404 }),
} satisfies ExportedHandler;
