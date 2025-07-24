import { subjects } from "../lib/auth/subjects";
import { factory } from "../utils/factory";

export const authMiddleware = factory.createMiddleware(async (c, next) => {
  const authClient = c.get("authClient");
  const authHeader = c.req.header("Authorization");
  if (!authHeader) {
    return await next();
  }

  const token = authHeader.replace("Bearer ", "");
  const verified = await authClient.verify(subjects, token);
  if (verified.err) {
    return await next();
  }

  c.set("user", verified.subject.properties);

  return await next();
});
