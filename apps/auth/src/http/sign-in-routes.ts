/**
 * The public routes of Commissary Cloud's sign-in on the auth host (ADR 0026, ADR 0030): the part of Better Auth's API
 * the panel uses (`/api/auth/*`, the providers' callbacks among them) and what the sign-in page needs
 * (`/api/sign-in-options`). The page itself (`/sign-in`) is the panel's, on the app host, and calls these routes across
 * origins (`cors.ts`). New in the Workers port.
 *
 * Better Auth checks its own requests' origin; the Worker also refuses writes from any origin but its own and the app
 * host's ({@link crossSiteWrite}), and starts a sign-in only with a Turnstile token (`turnstile.ts`). The one cross-site
 * write let through is a SAML identity provider posting its signed answer to the assertion consumer service.
 *
 * A sign-in through an org's identity provider (issue #76) starts from a work email: the Worker finds the org that
 * verified its domain and asks Better Auth's SSO plugin to sign in with that org's provider; an email of a domain no org
 * verified is refused there, without a redirect.
 */
import { Effect, Option, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  AUTH_BASE_PATH,
  AUTH_ROUTES,
  SIGN_IN_OPTIONS_PATH,
  SIGN_IN_PAGE_PATH,
  type SignInOptions,
} from "@commissary/contract/sign-in";
import { jsonReply } from "@commissary/core";
import { AuthDirectory } from "@commissary/auth";
import { emailDomain, providerIdOf } from "@commissary/auth/sso";
import { appOriginOf, authConfigurationProblem, enabledProviders } from "../sign-in/auth.ts";
import { signedInAuth } from "../sign-in/sessions.ts";
import { TURNSTILE_TOKEN_HEADER, verifyTurnstile } from "../sign-in/turnstile.ts";
import { AuthWorkerEnv } from "../worker-env.ts";
import { routeNotFound } from "./not-found.ts";

/** Better Auth's health check (`{ok: true}`), which the deploy checks call (tools/check-cloud-deploy.sh). */
export const AUTH_OK_PATH = `${AUTH_BASE_PATH}/ok`;

/** Better Auth's routes the Worker passes on; the rest of its API answers 404. */
const PASSED = new Set([
  `POST ${AUTH_ROUTES.signInSocial}`,
  `POST ${AUTH_ROUTES.signInSso}`,
  `GET ${AUTH_ROUTES.session}`,
  `POST ${AUTH_ROUTES.signOut}`,
  `GET ${AUTH_OK_PATH}`,
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

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const configurationProblem = Effect.gen(function* () {
  const env = yield* AuthWorkerEnv;
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
 * Whether a write must be refused before Better Auth sees it: its `Origin` is neither the app host's (the sign-in page
 * and the panel's sign-out) nor this host's, or the browser says another site started it. Non-browser clients send
 * neither header; a same-site request without an `Origin` is refused too (a browser names it on every write).
 */
export const crossSiteWrite = (
  method: string,
  headers: Readonly<Record<string, string | undefined>>,
  requestUrl: string,
  appOrigin: string,
): boolean => {
  if (SAFE_METHODS.has(method.toUpperCase())) return false;
  const origin = (headers["origin"] ?? "").trim();
  const site = (headers["sec-fetch-site"] ?? "").trim().toLowerCase();

  if (origin === "") return site === "cross-site" || site === "same-site";

  if (site === "cross-site") return true;

  return origin !== appOrigin && origin !== new URL(requestUrl).origin;
};

/**
 * `POST /api/auth/sign-in/sso {email}`: the request Better Auth's SSO plugin gets instead, for the identity provider of
 * the org that verified the email's domain; `undefined` when no org did (or it has no provider). The sign-in returns to
 * the panel on the app host.
 */
const ssoSignInRequest = (request: Request, input: typeof SsoSignIn.Type, appOrigin: string) =>
  Effect.gen(function* () {
    const directory = yield* AuthDirectory;

    if (input.email.length > MAX_EMAIL_LENGTH) return undefined;
    const email = input.email.trim().toLowerCase();
    const domain = emailDomain(email);

    if (domain === undefined) return undefined;
    const holder = yield* directory.ssoDomain(domain);

    if (holder === undefined) return undefined;
    const headers = new Headers(request.headers);

    headers.delete("content-length");
    headers.set("content-type", "application/json");

    return new Request(request.url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        providerId: providerIdOf(holder.org),
        callbackURL: `${appOrigin}/`,
        errorCallbackURL: `${appOrigin}${SIGN_IN_PAGE_PATH}`,
        loginHint: email,
      }),
    });
  });

/** `* /api/auth/*`: the Better Auth routes of {@link PASSED} and the providers' callbacks. */
const authRoute = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const env = yield* AuthWorkerEnv;
  const url = new URL(request.originalUrl, "http://localhost");

  if (!passed(request.method, url.pathname)) return yield* routeNotFound;

  const appOrigin = appOriginOf(env) ?? "";

  // The SAML answer comes from the identity provider's site; the plugin checks its signature, audience and request.
  if (
    !url.pathname.startsWith(SAML_ACS_PREFIX) &&
    crossSiteWrite(request.method, request.headers, request.originalUrl, appOrigin)
  )
    return jsonReply(403, { error: "Cross-site request rejected" });

  const problem = yield* configurationProblem;

  if (problem !== undefined) return problem;

  if (SIGN_IN_ROUTES.has(url.pathname)) {
    const secret = env.TURNSTILE_SECRET_KEY?.trim() ?? "";

    if (secret === "") {
      yield* Effect.logError("hosted sign-in is not configured: TURNSTILE_SECRET_KEY is missing");

      return jsonReply(500, { error: "Sign-in is not configured" });
    }

    // The widget renders on the sign-in page, on the app host.
    const outcome = yield* verifyTurnstile(
      secret,
      request.headers[TURNSTILE_TOKEN_HEADER],
      request.headers["cf-connecting-ip"],
      new URL(appOrigin).hostname,
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
      Option.isSome(input)
        ? ssoSignInRequest(web, input.value, appOrigin)
        : Effect.succeed(undefined)
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

  const directory = yield* AuthDirectory;

  const response = yield* Effect.tryPromise(async () =>
    (await signedInAuth(env, directory, url.origin)).handler(web),
  ).pipe(
    Effect.catch((error) =>
      Effect.logError(`sign-in request failed: ${error.message}`).pipe(Effect.as(undefined)),
    ),
  );

  if (response === undefined) return jsonReply(500, { error: "Sign-in failed" });

  return HttpServerResponse.setHeaders(HttpServerResponse.fromWeb(response), NO_STORE);
});

/** `GET /api/sign-in-options`: the enabled providers and the Turnstile site key, for the sign-in page. */
const signInOptions = Effect.gen(function* () {
  const env = yield* AuthWorkerEnv;

  const options: SignInOptions = {
    providers: [...enabledProviders(env)],
    turnstile_site_key: env.TURNSTILE_SITE_KEY?.trim() ?? "",
  };

  return HttpServerResponse.setHeaders(jsonReply(200, options), NO_STORE);
});

export const SignInRoutes = HttpRouter.addAll([
  HttpRouter.route("*", `${AUTH_BASE_PATH}/*`, authRoute),
  HttpRouter.route("GET", SIGN_IN_OPTIONS_PATH, signInOptions),
]);
