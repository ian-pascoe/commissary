/**
 * What `@commissary/state` reads from a Worker's env (#134 "How packages get their bindings"): the namespaces of its
 * Durable Objects, typed through its own classes ({@link StateBindings}, provided per request as {@link StateEnv}), and
 * the settings its Durable Object classes read from the `env` they are constructed with ({@link StateObjectEnv}). Each
 * Worker's own `env` must satisfy both.
 */
import { Context, Effect, Option } from "effect";
import { CurrentOrg, GLOBAL_ORG, type OrgId } from "@commissary/core";
import type { StateControlPlane } from "./control-plane.ts";
import { controlPlaneOf } from "./org.ts";
import type { Platform } from "./platform/platform.ts";
import type { SessionState } from "./session-state/durable-object.ts";

export interface StateBindings {
  /**
   * One ControlPlane per org, named by the org id (`controlPlaneOf`), seen as the org-wide base: a Worker binds the
   * base composed with the areas' parts (`composeControlPlane`), and an area reaches its part through its own view.
   */
  readonly CONTROL_PLANE: DurableObjectNamespace<StateControlPlane>;
  /** The Platform registry: one object per deployment (`platformOf`, `platform/registry.ts`). */
  readonly PLATFORM: DurableObjectNamespace<Platform>;
  /** Short-lived session state (`session-state/`). */
  readonly SESSION_STATE: DurableObjectNamespace<SessionState>;
}

/**
 * What the Durable Object classes read from the `env` they are constructed with: the bindings, the deployment's
 * platform admins (seeded as owners of `global`), its mode and the stage's secrets keys (`secrets/`).
 */
export interface StateObjectEnv extends StateBindings {
  /** `cloud`: Commissary Cloud (ADR 0026); unset or `self-hosted`: behind Cloudflare Access. */
  readonly COMMISSARY_MODE?: string | undefined;
  /** Comma separated platform admin emails: made owners of `global` once (`MemberStore.seedPlatformAdmins`). */
  readonly PLATFORM_ADMIN_EMAILS: string;
  /** Comma separated platform admin service token Client IDs. */
  readonly PLATFORM_ADMIN_SERVICE_TOKENS: string;
  /** Set on a deployed stage, where the dev secrets key is refused (`secrets/deployment-keys.ts`). */
  readonly ACCESS_TEAM_DOMAIN: string;
  readonly ACCESS_AUD: string;
  /** Secrets key of the stage: wraps every org's data key (`secrets/`). Missing: no ControlPlane starts. */
  readonly SECRETS_KEY: string;
  /** During a rotation, the secrets key `SECRETS_KEY` replaces. */
  readonly SECRETS_KEY_PREVIOUS?: string | undefined;
}

/**
 * The state bindings of the current Worker invocation. Provided per request through the `Context` handed to the web
 * handler (`requestContext`), never through a long-lived layer: bindings must not be captured across requests.
 */
export class StateEnv extends Context.Service<StateEnv, StateBindings>()(
  "commissary/state/StateEnv",
) {}

export type ControlPlaneStub = DurableObjectStub<StateControlPlane>;

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
