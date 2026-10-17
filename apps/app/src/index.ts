import { makeWebHandler } from "./http/app.ts";
import { misdirected } from "./http/hosts.ts";
import { requestContext } from "./worker-env.ts";
import { retryOnCodeUpdate } from "@commissary/state";
import { dispatchScheduled } from "./api/scheduled.ts";

// The handler (and its router) is built once per isolate; `env`/`ctx` are provided per request.
const { handler } = makeWebHandler();

// The Durable Objects live in the state Worker (apps/state, ADR 0030), bound by script name (alchemy.run.ts). A deploy
// of the state Worker resets them, and the calls cut off then are retried once (`retryOnCodeUpdate`).
export default {
  // A deployment with an API host serves the client API there and the rest on its app host (src/http/hosts.ts).
  fetch: (request, env, ctx) =>
    misdirected(request.url, env) ?? handler(request, requestContext(retryOnCodeUpdate(env), ctx)),
  // Cron jobs (model catalog refresh, ...) are listed in `scheduledTasks` (src/api/scheduled.ts).
  scheduled: (controller, env, ctx) => dispatchScheduled(controller, retryOnCodeUpdate(env), ctx),
} satisfies ExportedHandler<Env>;
