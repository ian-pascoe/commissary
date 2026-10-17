/**
 * `@commissary/models/state`, Models' entry for the state Worker (#134 "The area package convention"): its part of the
 * ControlPlane Durable Object. The apps import Models only through this entry, `./api` and `./management` (the lint
 * rule `boundaries/models-imports`).
 */
export { ModelsPart, type ModelsPartEnv } from "./control-plane-part.ts";
