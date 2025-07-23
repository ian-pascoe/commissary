import { issuer } from "@openauthjs/openauth";
import { CloudflareStorage } from "@openauthjs/openauth/storage/cloudflare";
import { providers } from "../lib/auth/providers";
import { subjects } from "../lib/auth/subjects";
import { db } from "../lib/db";
import { env } from "../utils/env";

export default issuer({
  subjects,
  providers,
  storage: CloudflareStorage({
    // @ts-ignore
    namespace: env().AUTH_KV,
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
