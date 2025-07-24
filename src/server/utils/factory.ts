import { createFactory } from "hono/factory";
import type { Env } from "~/server/types/hono";

export const factory = createFactory<Env>();
