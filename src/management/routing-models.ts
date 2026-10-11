/**
 * `GET /v8/management/routing/models`: which credentials serve each model clients can call, and the channel rules
 * (aliases, exclusions) that shape it. No Go counterpart (the Go panel has no such view); see `routingView`.
 *
 * Built from a fresh registry snapshot (`ModelRegistry.fresh`: config re-read, no 5 s cache), so a rule edit shows on
 * the next read. The cost is one config check, one `listModelSources` RPC and a pure pass over the credentials.
 */
import { Clock, Effect } from "effect";
import { routingView } from "../registry/routing-view.ts";
import { ModelRegistry } from "../registry/service.ts";
import { handled, jsonReply, replyError } from "./http.ts";

const routingModels = Effect.gen(function* () {
  const registry = yield* ModelRegistry;

  const snapshot = yield* registry.fresh.pipe(
    Effect.catch((error) =>
      Effect.logError(`routing/models: registry build failed: ${error.message}`).pipe(
        Effect.andThen(Effect.fail(replyError(502, "model registry unavailable"))),
      ),
    ),
  );

  const now = yield* Clock.currentTimeMillis;

  return jsonReply(200, routingView(snapshot, now));
});

export const routingModelsHandler = handled(routingModels);
