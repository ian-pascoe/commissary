import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import type * as z from "zod";
import { conversations } from "~~/drizzle/remote/schema";
import { Timestamp } from "./utils/timestamp";

export const Conversation = createSelectSchema(conversations, {
  createdAt: Timestamp,
  updatedAt: Timestamp,
  lastSyncedAt: Timestamp.nullish(),
}).partial({
  userId: true,
});
export type Conversation = z.infer<typeof Conversation>;

export const CreateConversation = createInsertSchema(conversations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  userId: true,
});
export type CreateConversationInput = z.input<typeof CreateConversation>;
export type CreateConversation = z.infer<typeof CreateConversation>;

export const UpdateConversation = createUpdateSchema(conversations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  userId: true,
});
export type UpdateConversationInput = z.input<typeof UpdateConversation>;
export type UpdateConversation = z.infer<typeof UpdateConversation>;
