// Org addressing of a request (ADR 0021), new in the Workers port: `/v9/management/orgs/<slug>/...` and `/o/<slug>/...`
// name the org a management request is for. The router matches the same routes without the org, so the web handler wraps
// the whole application in {@link orgAddressing}: the request the router and the handlers see has the org taken out of
// its `url`, while `originalUrl` keeps the address the client used, which the Access gate classifies and reads the org
// from ({@link addressedSlug}).
import { Effect } from "effect";
import { HttpServerRequest } from "effect/http";
import type { OrgSlug } from "@commissary/core";
import { scopedUrl } from "./zones.ts";

/** The org slug a request addresses, if its URL has one. */
export const addressedSlug = (request: HttpServerRequest.HttpServerRequest): OrgSlug | undefined =>
  scopedUrl(request.originalUrl)?.slug;

/**
 * Middleware of the web handler (`HttpRouter.toWebHandler(layer, { middleware })`, applied around the router and its
 * global middleware): routes an org-addressed request as the same request without the org.
 */
export const orgAddressing = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | HttpServerRequest.HttpServerRequest> =>
  Effect.updateService(effect, HttpServerRequest.HttpServerRequest, (request) => {
    const scoped = scopedUrl(request.originalUrl);

    return scoped === undefined ? request : request.modify({ url: scoped.url });
  });
