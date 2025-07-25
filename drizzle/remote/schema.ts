import type { UIMessage } from "ai";
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
import { syncModel } from "../utils/sync-model";
import { timestamp } from "../utils/timestamp";

export const users = sqliteTable(
  "users",
  {
    ...baseModel("user_"),

    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: integer("email_verified", { mode: "boolean" })
      .$defaultFn(() => !1)
      .notNull(),
    image: text("image"),
    isAnonymous: integer("is_anonymous", { mode: "boolean" }),
  },
  (t) => [
    uniqueIndex("users_email_idx").on(t.email),
    index("users_name_idx").on(t.name),
    index("users_is_anonymous_idx").on(t.isAnonymous),
  ],
);
export const userRelations = relations(users, ({ many }) => ({
  accounts: many(accounts),
  conversations: many(conversations),
  messages: many(messages),
}));

export const accounts = sqliteTable(
  "accounts",
  {
    ...baseModel("acc_"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
  },
  (t) => [
    index("accounts_user_id_idx").on(t.userId),
    index("accounts_account_id_idx").on(t.accountId),
    index("accounts_provider_id_idx").on(t.providerId),
  ],
);
export const accountRelations = relations(accounts, ({ one }) => ({
  user: one(users, {
    fields: [accounts.userId],
    references: [users.id],
  }),
}));

export const verifications = sqliteTable(
  "verifications",
  {
    ...baseModel("ver_"),

    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (t) => [index("verifications_identifier_idx").on(t.identifier)],
);

export const conversations = sqliteTable(
  "conversations",
  {
    ...baseModel("conv_"),
    ...syncModel,
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
    ...syncModel,
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
    parts: json().$type<UIMessage["parts"]>().notNull(),
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
