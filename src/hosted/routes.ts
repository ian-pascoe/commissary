/**
 * The public routes of a hosted proxy's sign-in (ADR 0026): the part of Better Auth's API the panel uses
 * (`/api/auth/*`), what the sign-in page needs (`/api/sign-in-options`) and the page itself (`/sign-in`). On a
 * self-hosted proxy none of them exists: they answer like any unknown path. New in the Workers port.
 *
 * Better Auth checks its own requests' origin; the Worker also refuses cross-site writes like on every other route
 * (`access/csrf.ts`), and starts a sign-in only with a Turnstile token (`turnstile.ts`).
 */
import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { crossSiteRejection } from "../access/csrf.ts";
import {
  AUTH_ROUTES,
  SIGN_IN_OPTIONS_PATH,
  SIGN_IN_PAGE_PATH,
  type SignInOptions,
} from "../management/contract/sign-in.ts";
import { jsonReply } from "../management/http.ts";
import { panelIndex } from "../management/web-panel.ts";
import { WorkerEnv } from "../platform/env.ts";
import { AUTH_BASE_PATH, authConfigurationProblem, enabledProviders } from "./auth.ts";
import { hostedOnly, routeNotFound } from "./only.ts";
import { signedInAuth } from "./session.ts";
import { TURNSTILE_TOKEN_HEADER, verifyTurnstile } from "./turnstile.ts";

/** Better Auth's routes the Worker passes on; the rest of its API answers 404. */
const PASSED = new Set([
  `POST ${AUTH_ROUTES.signInSocial}`,
  `GET ${AUTH_ROUTES.session}`,
  `POST ${AUTH_ROUTES.signOut}`,
]);

const CALLBACK_PREFIX = `${AUTH_BASE_PATH}/callback/`;

const NO_STORE = { "cache-control": "no-store" } as const;

const configurationProblem = Effect.gen(function* () {
  const env = yield* WorkerEnv;
  const problem = authConfigurationProblem(env);

  if (problem === undefined) return undefined;
  yield* Effect.logError(`hosted sign-in is not configured: ${problem}`);

  return jsonReply(500, { error: "Sign-in is not configured" });
});

const passed = (method: string, path: string): boolean =>
  PASSED.has(`${method} ${path}`) ||
  ((method === "GET" || method === "HEAD") &&
    path.startsWith(CALLBACK_PREFIX) &&
    !path.slice(CALLBACK_PREFIX.length).includes("/"));

/** `* /api/auth/*`: the Better Auth routes of {@link PASSED} and the providers' callbacks. */
const authRoute = hostedOnly(
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const env = yield* WorkerEnv;
    const url = new URL(request.originalUrl, "http://localhost");

    if (!passed(request.method, url.pathname)) return yield* routeNotFound;

    const rejection = crossSiteRejection(
      request.method,
      request.headers,
      request.originalUrl,
      "protected",
    );

    if (rejection !== undefined) return jsonReply(rejection.status, { error: rejection.message });

    const problem = yield* configurationProblem;

    if (problem !== undefined) return problem;

    if (url.pathname === AUTH_ROUTES.signInSocial) {
      const secret = env.TURNSTILE_SECRET_KEY?.trim() ?? "";

      if (secret === "") {
        yield* Effect.logError("hosted sign-in is not configured: TURNSTILE_SECRET_KEY is missing");

        return jsonReply(500, { error: "Sign-in is not configured" });
      }

      const outcome = yield* verifyTurnstile(
        secret,
        request.headers[TURNSTILE_TOKEN_HEADER],
        request.headers["cf-connecting-ip"],
        url.hostname,
      );

      if (outcome !== "passed")
        return jsonReply(outcome === "failed" ? 403 : 503, {
          error:
            outcome === "failed"
              ? "turnstile_failed"
              : "Turnstile is unavailable; try again in a moment",
        });
    }

    const web = yield* HttpServerRequest.toWeb(request).pipe(Effect.orDie);

    const response = yield* Effect.tryPromise(async () =>
      (await signedInAuth(env, url.origin)).handler(web),
    ).pipe(
      Effect.catch((error) =>
        Effect.logError(`sign-in request failed: ${error.message}`).pipe(Effect.as(undefined)),
      ),
    );

    if (response === undefined) return jsonReply(500, { error: "Sign-in failed" });

    return HttpServerResponse.setHeaders(HttpServerResponse.fromWeb(response), NO_STORE);
  }),
);

/** `GET /api/sign-in-options`: the enabled providers and the Turnstile site key, for the sign-in page. */
const signInOptions = hostedOnly(
  Effect.gen(function* () {
    const env = yield* WorkerEnv;

    const options: SignInOptions = {
      providers: [...enabledProviders(env)],
      turnstile_site_key: env.TURNSTILE_SITE_KEY?.trim() ?? "",
    };

    return HttpServerResponse.setHeaders(jsonReply(200, options), NO_STORE);
  }),
);

/** `GET /sign-in`: the panel, which shows its sign-in page there. */
const signInPage = hostedOnly(panelIndex);

export const HostedRoutes = HttpRouter.addAll([
  HttpRouter.route("*", `${AUTH_BASE_PATH}/*`, authRoute),
  HttpRouter.route("GET", SIGN_IN_OPTIONS_PATH, signInOptions),
  HttpRouter.route("GET", SIGN_IN_PAGE_PATH, signInPage),
]);
