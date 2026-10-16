/**
 * The ControlPlane Durable Object as the Worker binds it (`CONTROL_PLANE`, one object per org): the org-wide base
 * (`state/control-plane.ts`) composed with the areas' parts (#134 "How an area's ControlPlane part works", #148). Today
 * that is the Models part only.
 */
import { ModelsPart } from "./models/control-plane-part.ts";
import { OrgControlPlane } from "./state/control-plane.ts";

export class ControlPlane extends OrgControlPlane<{ readonly models: ModelsPart }> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env, { models: (core) => new ModelsPart(ctx, env, core) });
  }

  /**
   * The Models part, constructed once per object. A method rather than a getter, so a caller reaches the part in one
   * pipelined round trip, `stub.models().pick(…)`, under vitest-pool-workers too (which answers a getter of a Durable
   * Object stub with a function, #148). A test that evicts the object first disposes of any stub of the part it holds.
   */
  models(): ModelsPart {
    return this.parts.models;
  }
}
