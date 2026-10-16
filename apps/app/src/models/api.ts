/**
 * Models' entry for the API Worker (#134 "The area package convention"; `@commissary/models/api` once the folder becomes
 * the package, #151): its client API routes, its cron tasks and its view of `env`. Code outside `src/models/` imports
 * Models only through this module, `management.ts` and `state.ts` (the lint rule `boundaries/models-imports`).
 */
import { Layer } from "effect";
import { ClientApiLayer as ProtocolRoutes } from "./handlers/layer.ts";
import { ModelRoutesLive } from "./registry/live.ts";

export { type ModelsBindings, ModelsEnv } from "./env.ts";

export { TraceLayer } from "./observability/trace.ts";

export { scheduledTasks, ScheduledTaskLayer } from "./scheduled-tasks.ts";

/**
 * The client API routes with their production services: the protocol handlers (OpenAI, Responses, Claude, Gemini, …)
 * and the model listings. Handlers read `AccessPrincipal`: the Worker wraps the layer with its Access gate.
 */
export const ClientApiLayer = Layer.mergeAll(ProtocolRoutes, ModelRoutesLive);
