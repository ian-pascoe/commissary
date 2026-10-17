import { Layer } from "effect";
import { HttpRouter } from "effect/http";
import { AccessLayer, withAccess } from "../access/layer.ts";
import { orgAddressing } from "../management/org-address.ts";
import { HostedRoutes } from "../hosted/routes.ts";
import { ManagementRoutesLive } from "../management/routes.ts";
import { WorkersLoggerLayer } from "@commissary/core";
import { ClientApiLayer, TraceLayer } from "../models/api.ts";
import { OAuthCallbackRoutes } from "../models/management.ts";
import { RootRoutes } from "./routes.ts";

/**
 * All routes and global middleware of the Worker. Later slices merge their route layers here. Route layers whose
 * handlers use `AccessPrincipal` are wrapped with `withAccess(...)` (src/access/layer.ts); protected prefixes are
 * authenticated by `AccessLayer` regardless.
 */
export const AppLayer = Layer.mergeAll(
  RootRoutes,
  OAuthCallbackRoutes,
  // Sign-in of Commissary Cloud (ADR 0026); unknown paths on a self-hosted one.
  HostedRoutes,
  AccessLayer,
  withAccess(ClientApiLayer),
  withAccess(ManagementRoutesLive),
  // Request trace id header and structured request logs (src/models/observability).
  TraceLayer,
  WorkersLoggerLayer,
);

/**
 * Creates the Web `Request` handler. Per-request services (the env views, `WorkerExecutionContext`) are supplied as
 * the second argument of `handler`; see `requestContext` in `worker-env.ts`.
 */
export const makeWebHandler = () =>
  HttpRouter.toWebHandler(AppLayer, { disableLogger: true, middleware: orgAddressing });
