import { Context, Effect, Option } from "effect";
import {
  type ControlPlaneStub,
  controlPlaneOf,
  CurrentOrg,
  GLOBAL_ORG,
  type OrgId,
} from "./org.ts";

/**
 * Cloudflare bindings (`env`) of the current Worker invocation.
 *
 * Provided per request through the `Context` handed to the web handler, never through a
 * long-lived layer: bindings must not be captured across requests.
 */
export class WorkerEnv extends Context.Service<WorkerEnv, Env>()("commissary/platform/WorkerEnv") {}

/** Cloudflare `ExecutionContext` (`waitUntil`, `passThroughOnException`) of the current invocation. */
export class WorkerExecutionContext extends Context.Service<
  WorkerExecutionContext,
  ExecutionContext
>()("commissary/platform/WorkerExecutionContext") {}

/**
 * Builds the per-request context passed as the second argument of the web handler. Every request belongs to the org
 * `global` for now (ADR 0021); resolving the org from the request replaces this default later.
 */
export const requestContext = (
  env: Env,
  ctx: ExecutionContext,
): Context.Context<WorkerEnv | WorkerExecutionContext | CurrentOrg> =>
  Context.make(WorkerEnv, env).pipe(
    Context.add(WorkerExecutionContext, ctx),
    Context.add(CurrentOrg, GLOBAL_ORG),
  );

/** The ControlPlane of the current org (`controlPlaneOf`). */
export const currentControlPlane: Effect.Effect<ControlPlaneStub, never, WorkerEnv | CurrentOrg> =
  Effect.gen(function* () {
    return controlPlaneOf(yield* WorkerEnv, yield* CurrentOrg);
  });

/**
 * The org of code whose type cannot require {@link CurrentOrg} (the SessionState backends and the Antigravity executor,
 * which also run outside a request in unit tests): `global` only when there is no request at all (no `WorkerEnv`). A
 * request without an org is a defect, never a silent read of `global`'s state.
 */
export const optionalRequestOrg: Effect.Effect<OrgId> = Effect.gen(function* () {
  const org = yield* Effect.serviceOption(CurrentOrg);

  if (Option.isSome(org)) return org.value;

  if (Option.isSome(yield* Effect.serviceOption(WorkerEnv)))
    return yield* Effect.die(
      new Error("CurrentOrg is not provided for a request that has WorkerEnv"),
    );

  return GLOBAL_ORG;
});

const noop = (): void => undefined;

/**
 * Keeps the invocation alive (`ctx.waitUntil`) until the returned `release` is called. Used for bookkeeping that must
 * survive a client disconnect: workerd cancels the invocation's pending work when the client goes away unless a
 * `waitUntil` promise is outstanding, and the cancellation of a streamed body is processed asynchronously. Register
 * the hold while the request is still live, release it once the work is done. Without an execution context (unit
 * tests, after the invocation ended) this is a no-op.
 */
export const holdInvocation: Effect.Effect<() => void> = Effect.serviceOption(
  WorkerExecutionContext,
).pipe(
  Effect.map((ctx) => {
    if (Option.isNone(ctx)) return noop;
    let release: () => void = noop;

    const done = new Promise<void>((resolve) => {
      release = () => resolve();
    });

    try {
      ctx.value.waitUntil(done);
    } catch {
      return noop;
    }

    return release;
  }),
);
