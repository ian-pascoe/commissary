import { zValidator } from "@hono/zod-validator";
import { parseISO } from "date-fns";
import { and, eq, gte, or } from "drizzle-orm";
import * as z from "zod";
import { Conversation } from "~/schemas/conversation";
import { Message } from "~/schemas/messages";
import {
  conversations as conversationsTable,
  messages as messagesTable,
} from "~~/drizzle/remote/schema";
import { requireAuthMiddleware } from "../middleware/auth";
import { factory } from "../utils/factory";

const app = factory.createApp().post(
  "/",
  requireAuthMiddleware(),
  zValidator(
    "json",
    z.object({
      lastSyncAt: z
        .union([z.string(), z.date()])
        .transform((val) => (typeof val === "string" ? parseISO(val) : val)),
      data: z.object({
        conversations: z.array(Conversation).optional(), // Use any for now to avoid type conflicts
        messages: z.array(Message).optional(),
      }),
    }),
  ),
  async (c) => {
    try {
      const { lastSyncAt, data } = c.req.valid("json");
      const db = c.get("db");
      const user = c.get("user");
      const syncTimestamp = new Date();

      const promises: Promise<unknown>[] = [];

      // Handle incoming conversations with conflict resolution
      if (data.conversations?.length) {
        const conversationUpdates = data.conversations.map(
          async (conversation) => {
            // Check if record exists and get its last update time
            const existing = await db
              .select({ updatedAt: conversationsTable.updatedAt })
              .from(conversationsTable)
              .where(eq(conversationsTable.id, conversation.id))
              .limit(1);

            const existingUpdatedAt = existing[0]?.updatedAt;
            const shouldUpdate =
              existing.length === 0 ||
              (conversation.updatedAt &&
                existingUpdatedAt &&
                conversation.updatedAt >= existingUpdatedAt);

            if (shouldUpdate) {
              return db
                .insert(conversationsTable)
                .values({
                  ...conversation,
                  userId: user.id,
                  lastSyncedAt: syncTimestamp,
                  isDirty: false,
                })
                .onConflictDoUpdate({
                  target: conversationsTable.id,
                  set: {
                    title: conversation.title,
                    updatedAt: conversation.updatedAt || new Date(),
                    lastSyncedAt: syncTimestamp,
                    isDirty: false,
                  },
                });
            }
            return Promise.resolve();
          },
        );

        promises.push(...conversationUpdates);
      }

      // Handle incoming messages with conflict resolution
      if (data.messages?.length) {
        const messageUpdates = data.messages.map(async (message) => {
          // Check if record exists and get its last update time
          const existing = await db
            .select({ updatedAt: messagesTable.updatedAt })
            .from(messagesTable)
            .where(eq(messagesTable.id, message.id))
            .limit(1);

          // For messages, use updatedAt if available, otherwise use createdAt
          const messageUpdatedAt = message.updatedAt || message.createdAt;
          const existingUpdatedAt = existing[0]?.updatedAt;
          const shouldUpdate =
            existing.length === 0 ||
            (messageUpdatedAt &&
              existingUpdatedAt &&
              messageUpdatedAt >= existingUpdatedAt);

          if (shouldUpdate) {
            return db
              .insert(messagesTable)
              .values({
                ...message,
                userId: user.id,
                lastSyncedAt: syncTimestamp,
                isDirty: false,
              })
              .onConflictDoUpdate({
                target: messagesTable.id,
                set: {
                  role: message.role,
                  parts: message.parts,
                  updatedAt: messageUpdatedAt || new Date(),
                  lastSyncedAt: syncTimestamp,
                  isDirty: false,
                },
              });
          }
          return Promise.resolve();
        });

        promises.push(...messageUpdates);
      }

      // Get records that have been updated since last sync or are new
      const [conversations, messages] = await db.batch([
        db
          .select()
          .from(conversationsTable)
          .where(
            and(
              eq(conversationsTable.userId, user.id),
              or(
                gte(conversationsTable.updatedAt, lastSyncAt),
                gte(conversationsTable.createdAt, lastSyncAt),
              ),
            ),
          ),
        db
          .select()
          .from(messagesTable)
          .where(
            and(
              eq(messagesTable.userId, user.id),
              or(
                gte(messagesTable.updatedAt, lastSyncAt),
                gte(messagesTable.createdAt, lastSyncAt),
              ),
            ),
          ),
      ]);

      // Wait for all updates to complete
      await Promise.all(promises);

      return c.json({
        conversations,
        messages,
        syncedAt: syncTimestamp.toISOString(),
      });
    } catch (error) {
      console.error("Sync error:", error);
      return c.json(
        {
          error: "Sync failed",
          message: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      );
    }
  },
);

export default app;
