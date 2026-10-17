/**
 * The ControlPlane Durable Object as the Worker binds it (`CONTROL_PLANE`, one object per org): `@commissary/state`'s
 * org-wide base composed with the areas' parts (`composeControlPlane`; #134 "How an area's ControlPlane part works",
 * #148). Today that is the Models part only, reached as `stub.models().x(…)`.
 */
import { composeControlPlane } from "@commissary/state";
import { ModelsPart, type ModelsPartEnv } from "@commissary/models/state";

export class ControlPlane extends composeControlPlane({
  models: (ctx, env: ModelsPartEnv, core) => new ModelsPart(ctx, env, core),
}) {}
