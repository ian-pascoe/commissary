import { createFactory } from "hono/factory";
import type { Env } from "~/types/hono";

export const factory = createFactory<Env>();
