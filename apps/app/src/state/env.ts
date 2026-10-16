/**
 * What the future `@commissary/state` package reads from a Worker's env (#134 "How packages get their bindings"): the
 * namespaces of its Durable Objects, typed through its own classes. Each Worker provides its own `env` as
 * {@link StateEnv}; the Durable Object classes read their settings from the `env` they are constructed with.
 */
import { Context, Effect, Option } from "effect";
import type { ControlPlane } from "../credentials/control-plane.ts";
import { CurrentOrg, GLOBAL_ORG, type OrgId } from "@commissary/core";
import { controlPlaneOf } from "../platform/org.ts";
import type { Platform } from "../platform/platform.ts";
import type { SessionState } from "../session-state/durable-object.ts";

export interface StateBindings {
  /** One ControlPlane per org, named by the org id (`controlPlaneOf`). */
  readonly CONTROL_PLANE: DurableObjectNamespace<ControlPlane>;
  /** The Platform registry: one object per deployment (`platformOf`, `platform/registry.ts`). */
  readonly PLATFORM: DurableObjectNamespace<Platform>;
  /** Short-lived session state (`session-state/`). */
  readonly SESSION_STATE: DurableObjectNamespace<SessionState>;
}

/**
 * The state bindings of the current Worker invocation. Provided per request through the `Context` handed to the web
 * handler (`requestContext`), never through a long-lived layer: bindings must not be captured across requests.
 */
export class StateEnv extends Context.Service<StateEnv, StateBindings>()(
  "commissary/state/StateEnv",
) {}

export type ControlPlaneStub = DurableObjectStub<ControlPlane>;

/** The ControlPlane of the current org (`controlPlaneOf`). */
export const currentControlPlane: Effect.Effect<ControlPlaneStub, never, StateEnv | CurrentOrg> =
  Effect.gen(function* () {
    return controlPlaneOf(yield* StateEnv, yield* CurrentOrg);
  });

/**
 * The org of code whose type cannot require {@link CurrentOrg} (the SessionState backends and the Antigravity executor,
 * which also run outside a request in unit tests): `global` only when there is no request at all (no `StateEnv`). A
 * request without an org is a defect, never a silent read of `global`'s state.
 */
export const optionalRequestOrg: Effect.Effect<OrgId> = Effect.gen(function* () {
  const org = yield* Effect.serviceOption(CurrentOrg);

  if (Option.isSome(org)) return org.value;

  if (Option.isSome(yield* Effect.serviceOption(StateEnv)))
    return yield* Effect.die(
      new Error("CurrentOrg is not provided for a request that has StateEnv"),
    );

  return GLOBAL_ORG;
});
