// The plain 404 of a path the router does not know, as Gin answers it (the API Worker's CORS middleware does the same on
// the client API, apps/api/src/http/cors.ts). The app Worker answers no CORS: the panel, its sign-in and the
// management API are same-origin, and the management zone must not be readable across origins.
import { Effect, Predicate } from "effect";
import { HttpRouter, HttpServerError, HttpServerResponse } from "effect/http";

const notFound = HttpServerResponse.text("404 page not found", { status: 404 });

/** Global middleware: an unknown route answers the plain-text 404. */
export const NotFoundLayer = HttpRouter.middleware<{
  handles: HttpServerError.HttpServerError;
}>()(
  (app) =>
    app.pipe(
      Effect.catchTag("HttpServerError", (error) =>
        Predicate.isTagged(error.reason, "RouteNotFound")
          ? Effect.succeed(notFound)
          : Effect.fail(error),
      ),
    ),
  { global: true },
);
