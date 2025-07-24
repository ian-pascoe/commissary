import { type Client, createClient } from "@openauthjs/openauth/client";
import type { Context } from "hono";
import type { Env } from "~/server/types/hono";
import { c } from "~/server/utils/context";
import { env } from "~/server/utils/env";

let cachedAuthClient: Client | null = null;

export const initAuthClient = (ctx: Context<Env>) => {
  if (cachedAuthClient) {
    return cachedAuthClient;
  }

  const client = createClient({
    clientID: "commissary-api",
    issuer: `${env(ctx).API_URL}/auth`,
  });
  cachedAuthClient = client;
  return cachedAuthClient;
};

export const authClient = (ctx = c()) => {
  return ctx.get("authClient");
};
