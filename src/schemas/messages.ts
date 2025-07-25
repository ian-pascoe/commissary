import type { UIMessage } from "ai";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import * as z from "zod";
import { messages } from "~~/drizzle/remote/schema";
import { Timestamp } from "./utils/timestamp";

const MessageParts = z.custom<UIMessage["parts"]>();

export const Message = createSelectSchema(messages, {
  createdAt: Timestamp,
  updatedAt: Timestamp,
  lastSyncedAt: Timestamp.nullish(),
  parts: MessageParts,
}).partial({
  userId: true,
});
export type Message = z.infer<typeof Message>;

export const CreateMessage = createInsertSchema(messages, {
  parts: MessageParts,
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  conversationId: true,
  userId: true,
});
export type CreateMessageInput = z.input<typeof CreateMessage>;
export type CreateMessage = z.infer<typeof CreateMessage>;

export const UpdateMessage = createUpdateSchema(messages, {
  parts: z.optional(MessageParts),
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  conversationId: true,
  userId: true,
});
export type UpdateMessageInput = z.input<typeof UpdateMessage>;
export type UpdateMessage = z.infer<typeof UpdateMessage>;
