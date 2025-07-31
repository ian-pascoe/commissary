import type { MiddlewareHandler } from "hono";
import type { User } from "~/schemas/user";
import { auth } from "../lib/auth";
import type { Env, Variables } from "../types/hono";
import { factory } from "../utils/factory";

export const authMiddleware = () => {
  return factory.createMiddleware(async (c, next) => {
    const session = await auth(c).api.getSession({
      headers: c.req.raw.headers,
    });
    console.log("[Auth] Session retrieved:", session);
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
      const result = await c.get("auth").api.signInAnonymous();
      if (!result) {
        return c.json(
          { error: "Authentication required and anonymous sign-in failed." },
          401,
        );
      }

      c.header("set-auth-token", result.token);
      c.set("user", result.user as User);
    }
    return await next();
  };
};
