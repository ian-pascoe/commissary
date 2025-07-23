import { relations } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { baseModel } from "../utils/base-model";
import { json } from "../utils/json";
import { timestamp } from "../utils/timestamp";

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
export const userRelations = relations(users, ({ many }) => ({
  conversations: many(conversations),
  messages: many(messages),
}));

export const conversations = sqliteTable(
  "conversations",
  {
    ...baseModel("conv_"),
    userId: text()
      .notNull()
      .references(() => users.id, {
        onDelete: "cascade",
      }),

    title: text().notNull(),
  },
  (t) => [
    index("conversations_user_id_idx").on(t.userId),
    index("conversations_title_idx").on(t.title),
  ],
);
export const conversationRelations = relations(
  conversations,
  ({ one, many }) => ({
    user: one(users, {
      fields: [conversations.userId],
      references: [users.id],
    }),
    messages: many(messages),
  }),
);

export const messages = sqliteTable(
  "messages",
  {
    ...baseModel("msg_"),
    userId: text()
      .notNull()
      .references(() => users.id, {
        onDelete: "cascade",
      }),
    conversationId: text()
      .notNull()
      .references(() => conversations.id, {
        onDelete: "cascade",
      }),

    role: text({ enum: ["system", "user", "assistant"] }).notNull(),
    parts: json().notNull(),
    metadata: json(),
  },
  (t) => [
    index("messages_user_id_idx").on(t.userId),
    index("messages_conversation_id_idx").on(t.conversationId),
    index("messages_role_idx").on(t.role),
  ],
);
export const messageRelations = relations(messages, ({ one }) => ({
  user: one(users, {
    fields: [messages.userId],
    references: [users.id],
  }),
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
}));
