/**
 * The public routes of Commissary Cloud's sign-in (ADR 0026): the part of Better Auth's API the panel uses
 * (`/api/auth/*`), what the sign-in page needs (`/api/sign-in-options`) and the page itself (`/sign-in`). On a
 * self-hosted Commissary none of them exists: they answer like any unknown path. New in the Workers port.
 *
 * Better Auth checks its own requests' origin; the Worker also refuses cross-site writes like on every other route
 * (`access/csrf.ts`), and starts a sign-in only with a Turnstile token (`turnstile.ts`). The one cross-site write let
 * through is a SAML identity provider posting its signed answer to the assertion consumer service.
 *
 * A sign-in through an org's identity provider (issue #76) starts from a work email: the Worker finds the org that
 * verified its domain and asks Better Auth's SSO plugin to sign in with that org's provider; an email of a domain no org
 * verified is refused there, without a redirect.
 */
import { Effect, Option, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { crossSiteRejection } from "../access/csrf.ts";
import {
  AUTH_ROUTES,
  SIGN_IN_OPTIONS_PATH,
  SIGN_IN_PAGE_PATH,
  type SignInOptions,
} from "@commissary/contract/sign-in";
import { jsonReply } from "../management/http.ts";
import { panelIndex } from "../management/web-panel.ts";
import { WorkerEnv } from "../platform/env.ts";
import { platformOf } from "../platform/registry.ts";
import { emailDomain } from "../sso/domain.ts";
import { providerIdOf } from "../sso/provider.ts";
import { AUTH_BASE_PATH, authConfigurationProblem, enabledProviders } from "./auth.ts";
import { hostedOnly, routeNotFound } from "./only.ts";
import { signedInAuth } from "./session.ts";
import { TURNSTILE_TOKEN_HEADER, verifyTurnstile } from "./turnstile.ts";

/** Better Auth's routes the Worker passes on; the rest of its API answers 404. */
const PASSED = new Set([
  `POST ${AUTH_ROUTES.signInSocial}`,
  `POST ${AUTH_ROUTES.signInSso}`,
  `GET ${AUTH_ROUTES.session}`,
  `POST ${AUTH_ROUTES.signOut}`,
  `GET ${AUTH_BASE_PATH}/sso/saml2/sp/metadata`,
]);

/** Routes that end in one provider id: the social providers' and the identity providers' callbacks. */
const CALLBACK_PREFIX = `${AUTH_BASE_PATH}/callback/`;

const SSO_CALLBACK_PREFIX = `${AUTH_BASE_PATH}/sso/callback/`;

/** Where a SAML identity provider posts its answer (from its own site). */
const SAML_ACS_PREFIX = `${AUTH_BASE_PATH}/sso/saml2/sp/acs/`;

/** Routes that start a sign-in, so take a Turnstile token. */
const SIGN_IN_ROUTES = new Set<string>([AUTH_ROUTES.signInSocial, AUTH_ROUTES.signInSso]);

/** The longest work email the sign-in accepts. */
const MAX_EMAIL_LENGTH = 320;

const SsoSignIn = Schema.Struct({ email: Schema.String });

const NO_STORE = { "cache-control": "no-store" } as const;

const configurationProblem = Effect.gen(function* () {
  const env = yield* WorkerEnv;
  const problem = authConfigurationProblem(env);

  if (problem === undefined) return undefined;
  yield* Effect.logError(`hosted sign-in is not configured: ${problem}`);

  return jsonReply(500, { error: "Sign-in is not configured" });
});

const endsInOneSegment = (path: string, prefix: string): boolean =>
  path.startsWith(prefix) &&
  path.length > prefix.length &&
  !path.slice(prefix.length).includes("/");

const passed = (method: string, path: string): boolean =>
  PASSED.has(`${method} ${path}`) ||
  ((method === "GET" || method === "HEAD") &&
    (endsInOneSegment(path, CALLBACK_PREFIX) || endsInOneSegment(path, SSO_CALLBACK_PREFIX))) ||
  (method === "POST" && endsInOneSegment(path, SAML_ACS_PREFIX));

/**
 * `POST /api/auth/sign-in/sso {email}`: the request Better Auth's SSO plugin gets instead, for the identity provider of
 * the org that verified the email's domain; `undefined` when no org did (or it has no provider).
 */
const ssoSignInRequest = (request: Request, input: typeof SsoSignIn.Type) =>
  Effect.gen(function* () {
    const env = yield* WorkerEnv;

    if (input.email.length > MAX_EMAIL_LENGTH) return undefined;
    const email = input.email.trim().toLowerCase();
    const domain = emailDomain(email);

    if (domain === undefined) return undefined;
    const holder = yield* Effect.tryPromise(async () => await platformOf(env).ssoDomain(domain));

    if (holder === undefined) return undefined;
    const headers = new Headers(request.headers);

    headers.delete("content-length");
    headers.set("content-type", "application/json");

    return new Request(request.url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        providerId: providerIdOf(holder.org),
        callbackURL: "/",
        errorCallbackURL: SIGN_IN_PAGE_PATH,
        loginHint: email,
      }),
    });
  });

/** `* /api/auth/*`: the Better Auth routes of {@link PASSED} and the providers' callbacks. */
const authRoute = hostedOnly(
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const env = yield* WorkerEnv;
    const url = new URL(request.originalUrl, "http://localhost");

    if (!passed(request.method, url.pathname)) return yield* routeNotFound;

    // The SAML answer comes from the identity provider's site; the plugin checks its signature, audience and request.
    const rejection = url.pathname.startsWith(SAML_ACS_PREFIX)
      ? undefined
      : crossSiteRejection(request.method, request.headers, request.originalUrl, "protected");

    if (rejection !== undefined) return jsonReply(rejection.status, { error: rejection.message });

    const problem = yield* configurationProblem;

    if (problem !== undefined) return problem;

    if (SIGN_IN_ROUTES.has(url.pathname)) {
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

    let web = yield* HttpServerRequest.toWeb(request).pipe(Effect.orDie);

    if (url.pathname === AUTH_ROUTES.signInSso) {
      const input = yield* Effect.tryPromise(async () => await web.json()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(SsoSignIn)),
        Effect.option,
      );

      const forwarded = yield* (
        Option.isSome(input) ? ssoSignInRequest(web, input.value) : Effect.succeed(undefined)
      ).pipe(
        Effect.catch((error) =>
          Effect.logError(`single sign-on lookup failed: ${error.message}`).pipe(Effect.as(null)),
        ),
      );

      if (forwarded === null) return jsonReply(503, { error: "Sign-in failed; try again" });

      if (forwarded === undefined)
        return HttpServerResponse.setHeaders(
          jsonReply(404, {
            error: "sso_not_found",
            message: "No organization signs in people with this email's domain.",
          }),
          NO_STORE,
        );
      web = forwarded;
    }

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
