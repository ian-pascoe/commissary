/**
 * The management routes' plumbing that stays in the Worker: the ControlPlane stub and the JSON body readers (they
 * return `@commissary/json` values). Replies, the text and query readers and `handled` are `@commissary/core`.
 */
import { Effect } from "effect";
import { bodyText, type CurrentOrg, type Reply, replyError } from "@commissary/core";
import { isJsonObject, type Json } from "@commissary/json";
import { type ControlPlaneStub, currentControlPlane, type StateEnv } from "../state/env.ts";

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

/** Request body parsed as JSON (any value); 400 `invalid body` otherwise. */
export const bodyJson = Effect.gen(function* () {
  const text = yield* bodyText;

  return yield* Effect.try({
    // SAFETY: JSON.parse always returns a JSON value, so naming it Json only records that.
    try: () => JSON.parse(text) as Json,
    catch: () => replyError(400, "invalid body"),
  });
});

/** Request body parsed as a JSON object; 400 `invalid body` otherwise. */
export const bodyObject = bodyJson.pipe(
  Effect.flatMap((value) =>
    isJsonObject(value) ? Effect.succeed(value) : Effect.fail(replyError(400, "invalid body")),
  ),
);
