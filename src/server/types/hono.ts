import type { User } from "~/schemas/user";
import type { initCache } from "~/server/lib/cache";
import type { initDb } from "~/server/lib/db";
import type { initAuth } from "../lib/auth";
import type { initProviderRegistry } from "../lib/provider-registry";
import type { WorkerEnv } from "./cloudflare";

export type Bindings = WorkerEnv;

export type Variables = {
  db: ReturnType<typeof initDb>;
  cache: ReturnType<typeof initCache>;
  auth: ReturnType<typeof initAuth>;
  providerRegistry: ReturnType<typeof initProviderRegistry>;
  user?: User;
};

export type Env = {
  Bindings: Bindings;
  Variables: Variables;
};

declare module "hono" {
  interface ContextVariableMap extends Variables {}
}
