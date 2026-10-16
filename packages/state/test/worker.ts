// The test Worker's entry (vitest.config.ts): state's Durable Object classes on real SQLite storage. Its ControlPlane
// is the org-wide base composed as a Worker composes it (`composeControlPlane`), with two dummy area parts
// (test/support/dummy-part.ts) in place of the areas'.
import { composeControlPlane } from "../src/index.ts";
import { DummyPart } from "./support/dummy-part.ts";

export { Platform, SessionState } from "../src/index.ts";

export class ControlPlane extends composeControlPlane({
  dummy: (ctx, _env, core) => new DummyPart(ctx, "dummy", core),
  other: (ctx, _env, core) => new DummyPart(ctx, "other", core),
}) {}

export default {
  fetch: () => new Response("state's test Worker serves no requests", { status: 404 }),
} satisfies ExportedHandler;
