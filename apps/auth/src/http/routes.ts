// The auth Worker's own `/healthz` (each Worker has its own, #134), as the app and API Workers answer it.
import { HttpRouter, HttpServerResponse } from "effect/http";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

// The router falls back to GET for HEAD requests and the web handler drops the body.
const health = HttpServerResponse.text(JSON.stringify({ status: "ok" }), {
  contentType: JSON_CONTENT_TYPE,
});

export const RootRoutes = HttpRouter.add("GET", "/healthz", health);
