import type { UIMessage } from "ai";
import { relations } from "drizzle-orm";
import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { baseModel } from "../utils/base-model";
import { json } from "../utils/json";

export const conversations = sqliteTable(
  "conversations",
  {
    ...baseModel("conv_"),

    title: text().notNull(),
  },
  (t) => [index("conversations_title_idx").on(t.title)],
);
export const conversationRelations = relations(conversations, ({ many }) => ({
  messages: many(messages),
}));

export const messages = sqliteTable(
  "messages",
  {
    ...baseModel("msg_"),
    conversationId: text()
      .notNull()
      .references(() => conversations.id, {
        onDelete: "cascade",
      }),

    role: text({ enum: ["system", "user", "assistant"] }).notNull(),
    parts: json().$type<UIMessage["parts"]>().notNull(),
    metadata: json(),
  },
  (t) => [index("messages_conversation_id_idx").on(t.conversationId)],
);
export const messageRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
}));
