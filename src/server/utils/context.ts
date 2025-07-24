import { getContext } from "hono/context-storage";
import type { Env } from "~/server/types/hono";

export const c = () => {
  return getContext<Env>();
};
