/**
 * Routes that exist on Commissary Cloud only (ADR 0026): a self-hosted Commissary answers them like any path the router does
 * not know (`http/cors.ts` turns that into the plain 404), so nothing of them is reachable there.
 */
import { Effect } from "effect";
import { HttpServerError, HttpServerRequest } from "effect/http";
import { WorkerEnv } from "../platform/env.ts";
import { isHosted } from "./mode.ts";

/** Answers like a path the router does not know. */
export const routeNotFound = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;

  return yield* new HttpServerError.HttpServerError({
    reason: new HttpServerError.RouteNotFound({ request }),
  });
});

/** Runs `handler` on Commissary Cloud only. */
export const hostedOnly = <A, E, R>(handler: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const env = yield* WorkerEnv;

    return isHosted(env) ? yield* handler : yield* routeNotFound;
  });
