import type { initCache } from "~/server/lib/cache";
import type { initDb } from "~/server/lib/db";
import type { WorkerEnv } from "./cloudflare";

export type Bindings = WorkerEnv;

export type Variables = {
  db: ReturnType<typeof initDb>;
  cache: ReturnType<typeof initCache>;
};

export type Env = {
  Bindings: Bindings;
  Variables: Variables;
};

declare module "hono" {
  interface ContextVariableMap extends Variables {}
}
