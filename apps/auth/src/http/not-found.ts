// The auth host's answer to a path it does not serve (ADR 0030): a 404 naming the app host, where the panel, the
// sign-in page and the management API are.
import { Effect, Predicate } from "effect";
import { HttpRouter, HttpServerError, HttpServerRequest } from "effect/http";
import { jsonReply } from "@commissary/core";
import { appOriginOf } from "../sign-in/auth.ts";
import { AuthWorkerEnv } from "../worker-env.ts";

/** Answers like a path the router does not know. */
export const routeNotFound = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;

  return yield* new HttpServerError.HttpServerError({
    reason: new HttpServerError.RouteNotFound({ request }),
  });
});

/** Global middleware: an unknown route answers a JSON 404 that names the app host. */
export const NotFoundLayer = HttpRouter.middleware<{
  handles: HttpServerError.HttpServerError;
}>()(
  (app) =>
    app.pipe(
      Effect.catchTag("HttpServerError", (error) =>
        Predicate.isTagged(error.reason, "RouteNotFound")
          ? Effect.gen(function* () {
              const panel = appOriginOf(yield* AuthWorkerEnv);

              return jsonReply(404, {
                error:
                  panel === undefined
                    ? "Not found: this host serves sign-in only"
                    : `Not found: this host serves sign-in only; the control panel is at ${panel}`,
              });
            })
          : Effect.fail(error),
      ),
    ),
  { global: true },
);
