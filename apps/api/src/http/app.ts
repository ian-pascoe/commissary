import { Layer } from "effect";
import { HttpRouter } from "effect/http";
import { WorkersLoggerLayer } from "@commissary/core";
import { ClientApiLayer, TraceLayer } from "@commissary/models/api";
import { behindGate, GateLayer } from "./gate.ts";
import { RootRoutes } from "./routes.ts";

/**
 * All routes and global middleware of the API Worker (ADR 0030): `/healthz` and the client API of each area it mounts,
 * listed here explicitly (Models' for now), behind CORS and the client gate (`gate.ts`).
 */
export const ApiLayer = Layer.mergeAll(
  RootRoutes,
  GateLayer,
  behindGate(ClientApiLayer),
  // Request trace id header and structured request logs (packages/models/src/observability).
  TraceLayer,
  WorkersLoggerLayer,
);

/**
 * Creates the Web `Request` handler. Per-request services (the env views, `WorkerExecutionContext`) are supplied as
 * the second argument of `handler`; see `requestContext` in `worker-env.ts`.
 */
export const makeWebHandler = () => HttpRouter.toWebHandler(ApiLayer, { disableLogger: true });
