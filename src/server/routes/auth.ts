import { auth } from "../lib/auth";
import { factory } from "../utils/factory";

const app = factory.createApp().on(["POST", "GET"], "/*", (c) => {
  return auth(c).handler(c.req.raw);
});

export default app;
