/**
 * What a Worker's gate answers around `@commissary/auth`'s entry points (the app Worker's Access gate, the API Worker's
 * client gate): a failed authentication as a response with a flat `{"error": …}` body (mirrors AuthMiddleware in
 * internal/api/server_middleware.go), and the identity of a public route, which has no caller.
 */
import { Effect, Match } from "effect";
import { HttpServerResponse } from "effect/http";
import type { OrgId } from "@commissary/core";
import type { AccessError } from "./gate.ts";
import type { AccessIdentity, Principal } from "./principal.ts";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

const noPrincipal = (): never => {
  throw new Error("AccessPrincipal is not available on public routes");
};

/**
 * Identity provided on public routes, which have no caller. The router types every handler as possibly requiring
 * `AccessPrincipal`, but only route layers behind a gate read it; reading any field here is a defect, like a missing
 * service.
 */
export const PUBLIC_ROUTE_IDENTITY: AccessIdentity = {
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
