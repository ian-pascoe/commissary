import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { createId } from "~/utils/id";
import { json } from "./utils/json";
import { timestamp } from "./utils/timestamp";

const baseModel = (prefix: string) => ({
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

export const users = sqliteTable(
  "users",
  {
    ...baseModel("user_"),
    name: text().notNull(),
    email: text().notNull().unique(),
    emailVerified: integer({ mode: "boolean" }).notNull().default(false),
    emailVerifiedAt: timestamp(),
    image: text(),
  },
  (t) => [
    uniqueIndex("users_email_idx").on(t.email),
    index("users_name_idx").on(t.name),
    index("users_email_verified_idx").on(t.emailVerified),
  ],
);

export const chats = sqliteTable(
  "chats",
  {
    ...baseModel("chat_"),
    userId: text().notNull(),
    title: text().notNull(),
  },
  (t) => [
    index("chats_user_id_idx").on(t.userId),
    index("chats_title_idx").on(t.title),
  ],
);

export const messages = sqliteTable(
  "messages",
  {
    ...baseModel("msg_"),
    chatId: text().notNull(),
    userId: text().notNull(),
    parts: json().notNull(),
  },
  (t) => [
    index("messages_chat_id_idx").on(t.chatId),
    index("messages_user_id_idx").on(t.userId),
  ],
);
