import { integer } from "drizzle-orm/sqlite-core";
import { timestamp } from "./timestamp";

export const syncModel = {
  lastSyncedAt: timestamp(),
  isDirty: integer({ mode: "boolean" })
    .notNull()
    .$default(() => true),
  isDeleted: integer({ mode: "boolean" })
    .notNull()
    .$default(() => false),
};
