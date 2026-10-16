import { Context, Effect, Option } from "effect";

/** Cloudflare `ExecutionContext` (`waitUntil`, `passThroughOnException`) of the current invocation. */
export class WorkerExecutionContext extends Context.Service<
  WorkerExecutionContext,
  ExecutionContext
>()("commissary/platform/WorkerExecutionContext") {}

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
