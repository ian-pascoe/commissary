import { initCache } from "./lib/cache";
import { initDb } from "./lib/db";
import auth from "./routes/auth";
import { factory } from "./utils/factory";

const app = factory
  .createApp()
  .use((c, next) => {
    c.set("db", initDb(c));
    c.set("cache", initCache(c));
    return next();
  })
  .route("/auth", auth);

export default app;
