import { Layer } from "effect";
import { HttpRouter } from "effect/http";
import { WorkersLoggerLayer } from "@commissary/core";
import { CorsLayer } from "./cors.ts";
import { NotFoundLayer } from "./not-found.ts";
import { RootRoutes } from "./routes.ts";
import { SignInRoutes } from "./sign-in-routes.ts";

/**
 * All routes and global middleware of the auth Worker (ADR 0030): `/healthz` and the sign-in routes on the auth host,
 * behind CORS for the app origin (`cors.ts`); any other path answers a 404 naming the app host (`not-found.ts`).
 * Global middleware registered first is outermost.
 */
export const AuthLayer = Layer.mergeAll(
  CorsLayer,
  NotFoundLayer,
  RootRoutes,
  SignInRoutes,
  WorkersLoggerLayer,
);

/**
 * Creates the Web `Request` handler. Per-request services (the env view, the directory, `WorkerExecutionContext`) are
 * supplied as the second argument of `handler`; see `requestContext` in `worker-env.ts`.
 */
export const makeWebHandler = () => HttpRouter.toWebHandler(AuthLayer, { disableLogger: true });
