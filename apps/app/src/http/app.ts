import { Layer } from "effect";
import { HttpRouter } from "effect/http";
import { AccessLayer, withAccess } from "../access/layer.ts";
import { orgAddressing } from "../management/org-address.ts";
import { HostedRoutes } from "../hosted/routes.ts";
import { ManagementRoutesLive } from "../management/routes.ts";
import { WorkersLoggerLayer } from "@commissary/core";
import { TraceLayer } from "@commissary/models/api";
import { OAuthCallbackRoutes } from "@commissary/models/management";
import { RootRoutes } from "./routes.ts";

/**
 * All routes and global middleware of the app Worker: the panel, its sign-in and the management API. The client API is
 * the API Worker's (apps/api, ADR 0030). Route layers whose handlers use `AccessPrincipal` are wrapped with
 * `withAccess(...)` (src/access/layer.ts); the management zone is authenticated by `AccessLayer` regardless.
 */
export const AppLayer = Layer.mergeAll(
  RootRoutes,
  OAuthCallbackRoutes,
  // Sign-in of Commissary Cloud (ADR 0026); unknown paths on a self-hosted one.
  HostedRoutes,
  AccessLayer,
  withAccess(ManagementRoutesLive),
  // Request trace id header and structured request logs (packages/models/src/observability).
  TraceLayer,
  WorkersLoggerLayer,
);

/**
 * Creates the Web `Request` handler. Per-request services (the env views, `WorkerExecutionContext`) are supplied as
 * the second argument of `handler`; see `requestContext` in `worker-env.ts`.
 */
export const makeWebHandler = () =>
  HttpRouter.toWebHandler(AppLayer, { disableLogger: true, middleware: orgAddressing });
