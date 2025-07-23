import { env as envAdapter } from "hono/adapter";
import { c } from "./context";

export const env = (ctx = c()) => {
  return envAdapter(ctx);
};
