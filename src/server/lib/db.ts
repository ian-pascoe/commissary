import { drizzle } from "drizzle-orm/d1";
import type { Context } from "hono";
import * as schema from "~/drizzle/remote/schema";
import type { Env } from "~/types/hono";
import { c } from "../utils/context";
import { env } from "../utils/env";

export const initDb = (c: Context<Env>) => {
  return drizzle(env(c).DB, {
    schema,
  });
};

export const db = (ctx = c()) => ctx.get("db");
