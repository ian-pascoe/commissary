/**
 * Models' entry for the state Worker (#134 "The area package convention"; `@commissary/models/state` once the folder
 * becomes the package, #151): its part of the ControlPlane Durable Object. Code outside `src/models/` imports Models only
 * through this module, `api.ts` and `management.ts` (the lint rule `boundaries/models-imports`).
 */
export { ModelsPart, type ModelsPartEnv } from "./control-plane-part.ts";
