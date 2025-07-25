import type { MiddlewareHandler } from "hono";
import type { User } from "~/schemas/user";
import type { Env, Variables } from "../types/hono";
import { factory } from "../utils/factory";

export const authMiddleware = () => {
  return factory.createMiddleware(async (c, next) => {
    const auth = c.get("auth");
    const session = await auth.api.getSession({
      headers: c.req.raw.headers,
    });
    c.set("user", session?.user as User | undefined);
    return await next();
  });
};

export const requireAuthMiddleware = (): MiddlewareHandler<
  Env & { Variables: Variables & { user: User } }
> => {
  return async (c, next) => {
    const user = c.get("user");
    if (!user) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    return await next();
  };
};
