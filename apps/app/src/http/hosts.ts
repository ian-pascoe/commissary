// Which hostname serves what (ADR 0028), new in the Workers port: a deployment with an API host (`API_DOMAIN`) serves the
// client API routes there only, and the panel, sign-in and management API on its app host (`APP_DOMAIN`) only. Without
// `API_DOMAIN` one hostname serves everything. Decided before the router from the request's hostname and path, so a
// request on the wrong host never reaches the Access gate or a handler.
import { classifyPath, normalizedPath } from "../access/routes.ts";

/** Served on every host: the health check (`src/http/routes.ts`). */
const HEALTH_PATH = "/healthz";

/** The hosts of the deployment (`AppEnv`). */
interface HostEnv {
  readonly APP_DOMAIN?: string | undefined;
  readonly API_DOMAIN?: string | undefined;
}

const hostName = (value: string | undefined): string => (value ?? "").trim().toLowerCase();

/**
 * The API host of a deployment, as an `https://` origin; `undefined` when the deployment serves everything on one host.
 * The panel shows it as the address API keys are sent to (`GET /me` `api_url`).
 */
export const apiOrigin = (env: HostEnv): string | undefined => {
  const host = hostName(env.API_DOMAIN);

  return host === "" ? undefined : `https://${host}`;
};

const notFound = (message: string): Response =>
  new Response(JSON.stringify({ error: message }), {
    status: 404,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

/**
 * The answer to a request on a host that does not serve its path, `undefined` when the request goes on to the router.
 * With an API host: the API host serves the client API (the Access zone `protected`) and `/healthz`, every other host
 * (the app host) serves everything but the client API. Each refusal names the host that serves the path.
 */
export const misdirected = (requestUrl: string, env: HostEnv): Response | undefined => {
  const api = hostName(env.API_DOMAIN);

  if (api === "") return undefined;
  let host: string;

  try {
    host = new URL(requestUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }

  const clientApiRoute = classifyPath(requestUrl) === "protected";

  if (host === api) {
    if (clientApiRoute || normalizedPath(requestUrl) === HEALTH_PATH) return undefined;
    const app = hostName(env.APP_DOMAIN);

    return notFound(
      app === ""
        ? `Not found: ${api} serves the client API only`
        : `Not found: ${api} serves the client API only; the control panel and the management API are at https://${app}`,
    );
  }

  return clientApiRoute
    ? notFound(`Not found: the client API is served at https://${api}`)
    : undefined;
};
