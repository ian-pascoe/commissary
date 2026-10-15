// Router middleware gating the proxy and management routes (mirrors AuthMiddleware in
// internal/api/server_middleware.go: flat `{"error": "..."}` bodies).
import { Effect, Match, Predicate, Result } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { CurrentOrg, type OrgId } from "../platform/org.ts";
import { authenticateRequest } from "./authenticate.ts";
import type { AccessError } from "./authenticate.ts";
import { crossSiteRejection } from "./csrf.ts";
import { AccessJwks } from "./jwks.ts";
import { AccessPrincipal } from "./principal.ts";
import type { AccessIdentity, Principal } from "./principal.ts";
import { classifyPath, isPanelAssetPath, isPanelPagePath, normalizedPath } from "./routes.ts";
import { authenticateHosted } from "../hosted/gate.ts";
import { isHosted } from "../hosted/mode.ts";
import { SIGN_IN_PAGE_PATH } from "../management/contract/sign-in.ts";
import { WorkerEnv } from "../platform/env.ts";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

const noPrincipal = (): never => {
  throw new Error("AccessPrincipal is not available on public routes");
};

/**
 * Identity provided on public routes, which have no caller. The router types every handler as possibly requiring
 * `AccessPrincipal`, but only route layers wrapped with `withAccess` (all under protected prefixes) read it; reading
 * any field here is a defect, like a missing service.
 */
const PUBLIC_ROUTE_IDENTITY: AccessIdentity = {
  get principal(): Principal {
    return noPrincipal();
  },
  get principalId(): string {
    return noPrincipal();
  },
  get callerScope(): string {
    return noPrincipal();
  },
  get org(): OrgId {
    return noPrincipal();
  },
  get platformAdmin(): boolean {
    return noPrincipal();
  },
  get role(): undefined {
    return noPrincipal();
  },
  get memberId(): undefined {
    return noPrincipal();
  },
};

const errorResponse = (status: number, message: string) =>
  HttpServerResponse.text(JSON.stringify({ error: message }), {
    status,
    contentType: JSON_CONTENT_TYPE,
  });

/** Maps an authentication failure to a response; server-side failures are logged without details a client could use. */
export const accessErrorResponse = (
  error: AccessError,
): Effect.Effect<HttpServerResponse.HttpServerResponse> => {
  return Match.value(error).pipe(
    Match.tag("UnauthorizedError", (denied) => Effect.succeed(errorResponse(401, denied.message))),
    Match.tag("ForbiddenError", (denied) => Effect.succeed(errorResponse(403, denied.message))),
    Match.tag("NotFoundError", (missing) => Effect.succeed(errorResponse(404, missing.message))),
    Match.tag("RateLimitedError", (limited) =>
      Effect.succeed(
        HttpServerResponse.setHeader(
          errorResponse(429, limited.message),
          "retry-after",
          String(limited.retryAfterSeconds),
        ),
      ),
    ),
    Match.orElse((failure) =>
      Effect.logError(`authentication middleware error: ${failure._tag}: ${failure.message}`).pipe(
        Effect.as(errorResponse(500, "Authentication service error")),
      ),
    ),
  );
};

/**
 * On a hosted proxy, a browser that opens a panel page without a session goes to the sign-in page, which brings it back
 * (`next`, a path of this origin) once signed in.
 */
const signInRedirect = (
  request: HttpServerRequest.HttpServerRequest,
  failure: AccessError,
): HttpServerResponse.HttpServerResponse | undefined => {
  const url = new URL(request.originalUrl, "http://localhost");

  if (
    !Predicate.isTagged(failure, "UnauthorizedError") ||
    (request.method !== "GET" && request.method !== "HEAD") ||
    !isPanelPagePath(normalizedPath(request.originalUrl) ?? "")
  )
    return undefined;

  const next = `${url.pathname}${url.search}`;

  return HttpServerResponse.redirect(
    next === "/" ? SIGN_IN_PAGE_PATH : `${SIGN_IN_PAGE_PATH}?next=${encodeURIComponent(next)}`,
    { status: 302, headers: { "cache-control": "no-store" } },
  );
};

/**
 * Global middleware: requests under the protected prefixes (see `routes.ts`) must carry a valid Access JWT, or on a
 * proxy route an API key (`api-key.ts`), and come from a member of the request's org with the role the route needs
 * (`policy.ts`, ADR 0022): a platform admin
 * (`PLATFORM_ADMIN_*`) is an owner of every org, anyone else has the role their membership gives them. Cross-site
 * requests and cross-origin WebSocket upgrades are refused first (`csrf.ts`). Everything else (`/healthz`, unknown
 * paths) is passed through untouched. On success the principal is available to handlers as `AccessPrincipal`, and
 * `CurrentOrg` is the org of the request: the org addressed by an org-scoped management URL (`org-address.ts`), the
 * org an API key names, unchanged otherwise.
 *
 * Register it after `CorsLayer` so that 401/403 responses still carry CORS headers and preflights are not gated.
 */
export const AccessGate = HttpRouter.middleware<{ provides: AccessPrincipal }>()(
  Effect.gen(function* () {
    // Resolved when the layer is built (once per isolate); `WorkerEnv` stays a per-request service.
    const jwks = yield* AccessJwks;

    return (app) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const zone = classifyPath(request.originalUrl);

        const hosted = isHosted(yield* WorkerEnv);

        // A hosted proxy's sign-in page loads the panel's bundle before anyone is signed in; the bundle holds no data.
        if (zone === "public" || (hosted && isPanelAssetPath(request.originalUrl))) {
          return yield* Effect.provideService(app, AccessPrincipal, PUBLIC_ROUTE_IDENTITY);
        }

        const rejection = crossSiteRejection(
          request.method,
          request.headers,
          request.originalUrl,
          zone,
        );

        if (rejection !== undefined) return errorResponse(rejection.status, rejection.message);

        const authenticated = yield* Effect.result(
          hosted
            ? authenticateHosted(request.headers, request.originalUrl, zone, request.method)
            : authenticateRequest(request.headers, request.originalUrl, zone, request.method).pipe(
                Effect.provideService(AccessJwks, jwks),
              ),
        );

        if (Result.isFailure(authenticated)) {
          const page = hosted ? signInRedirect(request, authenticated.failure) : undefined;

          return page ?? (yield* accessErrorResponse(authenticated.failure));
        }

        return yield* app.pipe(
          Effect.provideService(AccessPrincipal, authenticated.success),
          Effect.provideService(CurrentOrg, authenticated.success.org),
        );
      });
  }),
  { global: true },
);
