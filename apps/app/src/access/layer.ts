import { Layer } from "effect";
import { makeCorsLayer } from "../api/cors.ts";
import { AccessJwks } from "@commissary/auth";
import { classifyPath } from "../management/zones.ts";
import { AccessGate } from "./middleware.ts";

/**
 * The client API's CORS (`api/cors.ts`). Deviation from Go: the management zone (`/v9/management*`, the control panel
 * at `/` and its pages, the legacy `/management.html` redirect) gets no CORS headers at all, so other origins can
 * neither pass a preflight nor read a management response with an admin's Access cookie. The panel is served by the
 * Worker itself and does not need CORS.
 */
const CorsLayer = makeCorsLayer((requestUrl) => classifyPath(requestUrl) === "management");

/**
 * CORS plus the Access gate, in that order: global middleware registered first is outermost, so preflights are
 * answered before authentication and 401/403 responses still carry CORS headers. `jwks` is replaceable in tests.
 */
export const makeAccessLayer = (jwks: Layer.Layer<AccessJwks> = AccessJwks.layerLive) =>
  AccessGate.pipe(Layer.provide(Layer.mergeAll(CorsLayer, jwks)));

/** Builds the `withAccess` helper for a given Access layer (tests pass one with a fake JWKS). */
export const makeWithAccess =
  <PA, PE, PR>(access: Layer.Layer<PA, PE, PR>) =>
  <A, E, R>(routes: Layer.Layer<A, E, R>) =>
    routes.pipe(Layer.provide(access));

/** The production Access layer; a singleton so every `withAccess` shares one registration of the middleware. */
export const AccessLayer = makeAccessLayer();

/**
 * Marks route layers as consumers of `AccessPrincipal`: `withAccess(routes)` discharges that requirement at the type
 * level. Authentication itself is global (gated by path prefix, see `management/zones.ts`), so routes under a
 * protected prefix are authenticated whether or not they use this helper; it only makes `yield* AccessPrincipal`
 * compile and keeps the Worker handler's context free of it.
 */
export const withAccess = makeWithAccess(AccessLayer);
