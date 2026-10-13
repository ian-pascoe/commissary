/**
 * Management API routes (`/v8/management/*`), the control panel (`web/`, at `/`) and the old panel's address
 * (`/management.html`, a redirect to `/`).
 *
 * Go source: internal/api/server_management_v8.go (route table). Authorization is the Access admin gate
 * (`access/routes.ts`: the whole `/v8/management` prefix, the panel paths and `/management.html`), which replaces the
 * Go management key, IP ban and `allow-remote` logic. Routes that are not ported: plugins, Home, the file-log routes,
 * `GET /server/latest-version`, the static `routing/model-definitions/:channel` catalog, `GET /oauth/callback` and
 * `GET /observability/usage/api-keys` (all four only fed the upstream panel; the control panel reads
 * `routing/models`, `credentials/models`, `POST /oauth/callback` and `api-keys`), the deprecated `/v0/management`
 * tree, `POST /requests/api-call` (the upstream panel's token-substituting upstream probe; quota and key checks and
 * Claude reset grants run server-side, so tokens never leave the Worker), and the upstream panel page itself (Go serves it at
 * `/management.html`; here that path redirects to `/`). The upstream panel's `X-CPA-Version` and
 * `X-CPA-Support-Plugin` response headers are not sent. OAuth
 * login (`/oauth/*`) is in `oauth-routes.ts`; the batch account actions (`/credentials/batch`) in
 * `credentials-batch.ts`; usage (`/observability/usage/*`) is in `usage-routes.ts`; the
 * per-model routing view (`/routing/models`) in `routing-models.ts`; the Settings page (`/settings`) in
 * `settings-routes.ts` and its raw configuration editor (`/settings/config`) in `settings-raw-routes.ts`; Claude reset
 * grants (`/credentials/reset-grants`) in `reset-grant-routes.ts`; the model catalog's status and on-demand refresh (`/models/catalog`) in
 * `catalog-routes.ts`.
 */
import { Effect, Layer } from "effect";
import {
  FetchHttpClient,
  type HttpClient,
  HttpRouter,
  type HttpServerRequest,
  type HttpServerResponse,
} from "effect/http";
import { LEGACY_PANEL_PATH } from "../access/routes.ts";
import { routeServices } from "../http/route-services.ts";
import type { WorkerEnv } from "../platform/env.ts";
import type { CurrentOrg } from "../platform/org.ts";
import { CatalogStore } from "../registry/catalog-store.ts";
import { ModelRegistryLive } from "../registry/live.ts";
import type { ModelRegistry } from "../registry/service.ts";
import { apiKeyProbeHandler, apiKeysRoutes } from "./api-keys-routes.ts";
import { catalogRefreshHandler, catalogStatusHandler } from "./catalog-routes.ts";
import { configRoutes } from "./config-routes.ts";
import { credentialsBatchHandler } from "./credentials-batch.ts";
import { credentialModelsHandler, credentialRoutes } from "./credentials-routes.ts";
import { oauthRoutes } from "./oauth-routes.ts";
import { quotaCheckHandler, quotaSweepHandler } from "./quota-routes.ts";
import { claimResetGrantHandler, resetGrantsHandler } from "./reset-grant-routes.ts";
import { routingModelsHandler } from "./routing-models.ts";
import { settingsRawRoutes } from "./settings-raw-routes.ts";
import { settingsRoutes } from "./settings-routes.ts";
import {
  LEGACY_PANEL_REDIRECT,
  PANEL_PAGE_PATHS,
  webPanelAsset,
  webPanelPage,
} from "./web-panel.ts";
import { usageRoutes } from "./usage-routes.ts";

const BASE = "/v8/management";

/** All management routes; needs `ModelRegistry`, the `CatalogStore` and an `HttpClient`. */
export const ManagementRoutes = HttpRouter.addAll(
  Effect.gen(function* () {
    // Handlers run per request: bind the isolate-wide services once instead of leaking them into the request context.
    const services = yield* routeServices<ModelRegistry | HttpClient.HttpClient | CatalogStore>();

    const bound = <
      R extends
        | ModelRegistry
        | HttpClient.HttpClient
        | CatalogStore
        | WorkerEnv
        | CurrentOrg
        | HttpServerRequest.HttpServerRequest,
    >(
      handler: Effect.Effect<HttpServerResponse.HttpServerResponse, never, R>,
    ) => Effect.provide(handler, services);

    return [
      ...configRoutes,
      ...apiKeysRoutes,
      ...settingsRoutes,
      ...settingsRawRoutes,
      ...credentialRoutes,
      ...usageRoutes,
      ...oauthRoutes,
      HttpRouter.route("GET", `${BASE}/credentials/models`, bound(credentialModelsHandler)),
      HttpRouter.route("POST", `${BASE}/credentials/batch`, credentialsBatchHandler),
      HttpRouter.route("POST", `${BASE}/credentials/quota`, bound(quotaCheckHandler)),
      HttpRouter.route("POST", `${BASE}/credentials/quota/all`, bound(quotaSweepHandler)),
      HttpRouter.route("GET", `${BASE}/credentials/reset-grants`, bound(resetGrantsHandler)),
      HttpRouter.route(
        "POST",
        `${BASE}/credentials/reset-grants/claim`,
        bound(claimResetGrantHandler),
      ),
      HttpRouter.route("POST", `${BASE}/api-keys/probe`, bound(apiKeyProbeHandler)),
      HttpRouter.route("GET", `${BASE}/routing/models`, bound(routingModelsHandler)),
      HttpRouter.route("GET", `${BASE}/models/catalog`, bound(catalogStatusHandler)),
      HttpRouter.route("POST", `${BASE}/models/catalog/refresh`, bound(catalogRefreshHandler)),
      HttpRouter.route("GET", LEGACY_PANEL_PATH, LEGACY_PANEL_REDIRECT),
      ...PANEL_PAGE_PATHS.map((path) => HttpRouter.route("GET", path, webPanelPage)),
      HttpRouter.route("GET", "/assets/*", webPanelAsset),
    ];
  }),
);

/** Production wiring: ControlPlane-backed model registry and the global `fetch`. Wrap with `withAccess(...)`. */
export const ManagementRoutesLive = ManagementRoutes.pipe(
  Layer.provide(Layer.mergeAll(ModelRegistryLive, FetchHttpClient.layer, CatalogStore.layer)),
);
