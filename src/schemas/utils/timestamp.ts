import { parseISO } from "date-fns";
import * as z from "zod";

export const Timestamp = z
  .union([z.iso.datetime(), z.date()])
  .transform((v) => (typeof v === "string" ? parseISO(v) : v));
