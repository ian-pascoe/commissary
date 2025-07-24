import { issuer } from "@openauthjs/openauth";
import { CloudflareStorage } from "@openauthjs/openauth/storage/cloudflare";
import { providers } from "../lib/auth/providers";
import { subjects } from "../lib/auth/subjects";
import { db } from "../lib/db";
import { c } from "../utils/context";
import { env } from "../utils/env";
import { factory } from "../utils/factory";

const auth = (ctx = c()) =>
  issuer({
    subjects,
    providers,
    storage: CloudflareStorage({
      // @ts-ignore
      namespace: env(ctx).AUTH_KV,
    }),
    success: async (ctx, value) => {
      switch (value.provider) {
        case "password": {
          const user = await db().query.users.findFirst({
            where: (users, { eq }) => eq(users.email, value.email),
          });
          if (!user) {
            throw new Error("User not found");
          }
          return ctx.subject("user", user);
        }
        default: {
          throw new Error(`Invalid provider: ${value.provider}`);
        }
      }
    },
  });

export default factory.createApp().all("/*", (c) => {
  return auth(c).fetch(c.req.raw, env(c), c.executionCtx);
});
