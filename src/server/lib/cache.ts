import type { Context } from "hono";
import type { Env } from "~/server/types/hono";
import { c } from "../utils/context";
import { env } from "../utils/env";

export const initCache = (c: Context<Env>) => {
  return env(c).KV;
};

export const cache = (ctx = c()) => ctx.get("cache");
