import { text } from "drizzle-orm/sqlite-core";
import { createId } from "~/utils/id";
import { timestamp } from "./timestamp";

export const baseModel = (prefix: string) => ({
  id: text()
    .primaryKey()
    .$default(() => createId(prefix)),
  createdAt: timestamp()
    .notNull()
    .$default(() => new Date()),
  updatedAt: timestamp()
    .notNull()
    .$default(() => new Date())
    .$onUpdate(() => new Date()),
});
