// CORS of the auth host (ADR 0030, #133): the sign-in page and the panel's sign-out run on the app host and call the
// auth Worker with `credentials: "include"`, so it answers that one origin (`APP_ORIGIN`) with credentials, and no
// other. Better Auth's `trustedOrigins` is the same origin (`sign-in/auth.ts`).
import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { appOriginOf } from "../sign-in/auth.ts";
import { TURNSTILE_TOKEN_HEADER } from "../sign-in/turnstile.ts";
import { AuthWorkerEnv } from "../worker-env.ts";

/** What the sign-in page sends: JSON, with the Turnstile token in its own header. */
const ALLOWED_METHODS = ["GET", "POST"];

const ALLOWED_HEADERS = ["content-type", TURNSTILE_TOKEN_HEADER];

/** The CORS headers of an answer to the app origin. */
const allowedOrigin = (origin: string) => ({
  "access-control-allow-origin": origin,
  "access-control-allow-credentials": "true",
  vary: "Origin",
});

/**
 * The answer to a preflight (`OPTIONS` with `Access-Control-Request-Method`), before routing: `204` with the allowed
 * methods and headers for the app origin, `403` without any CORS header for every other.
 */
export const preflight = (
  headers: Readonly<Record<string, string | undefined>>,
  appOrigin: string | undefined,
): HttpServerResponse.HttpServerResponse => {
  const origin = (headers["origin"] ?? "").trim();
  const method = (headers["access-control-request-method"] ?? "").trim().toUpperCase();

  if (appOrigin === undefined || origin !== appOrigin || !ALLOWED_METHODS.includes(method))
    return HttpServerResponse.empty({ status: 403, headers: { vary: "Origin" } });

  return HttpServerResponse.empty({
    status: 204,
    headers: {
      ...allowedOrigin(origin),
      "access-control-allow-methods": ALLOWED_METHODS.join(", "),
      "access-control-allow-headers": ALLOWED_HEADERS.join(", "),
      "access-control-max-age": "600",
    },
  });
};

/** Global middleware: preflights answered before routing, and the app origin's other requests readable by it. */
export const CorsLayer = HttpRouter.middleware()(
  (app) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const appOrigin = appOriginOf(yield* AuthWorkerEnv);

      if (
        request.method === "OPTIONS" &&
        request.headers["access-control-request-method"] !== undefined
      )
        return preflight(request.headers, appOrigin);

      const response = yield* app;
      const origin = (request.headers["origin"] ?? "").trim();

      return appOrigin !== undefined && origin === appOrigin
        ? HttpServerResponse.setHeaders(response, allowedOrigin(origin))
        : HttpServerResponse.setHeader(response, "vary", "Origin");
    }),
  { global: true },
);
