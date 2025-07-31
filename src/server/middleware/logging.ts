import { factory } from "../utils/factory";

export const loggingMiddleware = () => {
  return factory.createMiddleware(async (c, next) => {
    console.log("[Logging] Incoming request:", {
      method: c.req.method,
      url: c.req.url,
      headers: c.req.raw.headers,
    });
    const result = await next();
    console.log("[Logging] Outgoing response:", {
      status: c.res.status,
      headers: c.res.headers,
    });
    return result;
  });
};
