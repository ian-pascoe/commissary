/** The management routes' way to the ControlPlane: a call over its stub, answered with 502 when the RPC fails. */
import { Effect } from "effect";
import { type CurrentOrg, type Reply, replyError } from "@commissary/core";
import { type ControlPlaneStub, currentControlPlane, type StateEnv } from "./env.ts";

/** Calls a ControlPlane stub; a failed RPC is logged (never with payloads) and answered with 502. */
export const callControlPlane = <S, R>(
  label: string,
  stub: S,
  call: (stub: S) => R,
): Effect.Effect<Awaited<R>, Reply> =>
  Effect.tryPromise({
    // RPC results are promise-pipelining stubs; `await` yields the plain data.
    try: async (): Promise<Awaited<R>> => await call(stub),
    catch: (cause) => (cause instanceof Error ? cause.message : "unknown error"),
  }).pipe(
    Effect.catch((message) =>
      Effect.logError(`management ${label} failed: ${message}`).pipe(
        Effect.andThen(Effect.fail(replyError(502, "control plane unavailable"))),
      ),
    ),
  );

/** Calls the current org's ControlPlane ({@link callControlPlane}). */
export const controlPlane = <R>(
  label: string,
  call: (stub: ControlPlaneStub) => R,
): Effect.Effect<Awaited<R>, Reply, StateEnv | CurrentOrg> =>
  Effect.flatMap(currentControlPlane, (stub) => callControlPlane(label, stub, call));
