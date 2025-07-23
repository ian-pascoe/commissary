import type { webapp } from "../../alchemy.run";

export type WorkerEnv = typeof webapp.Env;

declare module "cloudflare:workers" {
  namespace Cloudflare {
    export interface Env extends WorkerEnv {}
  }
}
