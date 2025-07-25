import { zValidator } from "@hono/zod-validator";
import {
  convertToModelMessages,
  createUIMessageStream,
  JsonToSseTransformStream,
  streamText,
  type UIMessage,
} from "ai";
import { stream } from "hono/streaming";
import * as z from "zod";
import { Conversation } from "~/schemas/conversation";
import { ModelId } from "~/schemas/model";
import {
  conversations,
  messages as messagesTable,
} from "~~/drizzle/remote/schema";
import { providerRegistry } from "../lib/model";
import { requireAuthMiddleware } from "../middleware/auth";
import { factory } from "../utils/factory";

const app = factory.createApp().post(
  "/",
  requireAuthMiddleware(),
  zValidator(
    "json",
    z.object({
      messages: z.array(z.custom<UIMessage>()),
      modelId: ModelId,
      conversation: Conversation,
    }),
  ),
  async (c) => {
    const {
      messages,
      modelId,
      conversation: clientConversation,
    } = c.req.valid("json");
    const db = c.get("db");
    const user = c.get("user");

    // Check if conversation exists in remote database
    let conversation = await db.query.conversations.findFirst({
      where: (c, { eq }) => eq(c.id, clientConversation.id),
    });

    // If conversation doesn't exist, create it using the client conversation data
    if (!conversation) {
      try {
        const [createdConversation] = await db
          .insert(conversations)
          .values({
            id: clientConversation.id, // Use the client's ID
            userId: user.id,
            title: clientConversation.title,
            createdAt: clientConversation.createdAt,
            updatedAt: clientConversation.updatedAt,
            // Sync fields - server creates as already synced
            isDirty: false,
            lastSyncedAt: new Date(),
          })
          .returning();

        if (!createdConversation) {
          return c.json({ error: "Failed to create conversation" }, 500);
        }
        conversation = createdConversation;
      } catch (error) {
        // Handle case where conversation might have been created by another request
        console.warn(
          "Conversation creation conflict, fetching existing:",
          error,
        );
        conversation = await db.query.conversations.findFirst({
          where: (c, { eq }) => eq(c.id, clientConversation.id),
        });

        if (!conversation) {
          return c.json(
            { error: "Failed to create or find conversation" },
            500,
          );
        }
      }
    }

    const promises: Promise<unknown>[] = [];

    const dataStream = createUIMessageStream({
      execute: ({ writer }) => {
        const result = streamText({
          model: providerRegistry().languageModel(modelId),
          messages: convertToModelMessages(messages),
        });
        writer.merge(result.toUIMessageStream());
      },
      onFinish: ({ responseMessage }) => {
        // Save assistant message to database with sync fields
        promises.push(
          db.insert(messagesTable).values({
            userId: user.id,
            conversationId: conversation.id,
            ...responseMessage,
            // Sync fields - server creates as already synced
            isDirty: false,
            lastSyncedAt: new Date(),
          }),
        );

        // Also save the user message if it doesn't exist
        const userMessage = messages[messages.length - 1];
        if (userMessage) {
          promises.push(
            db
              .insert(messagesTable)
              .values({
                userId: user.id,
                conversationId: conversation.id,
                ...userMessage,
                // Sync fields
                isDirty: false,
                lastSyncedAt: new Date(),
              })
              .onConflictDoNothing(), // Don't duplicate if already exists
          );
        }
      },
    });

    c.executionCtx.waitUntil(Promise.all(promises));

    c.header("content-type", "text/event-stream");
    c.header("cache-control", "no-cache");
    c.header("connection", "keep-alive");
    c.header("x-vercel-ai-ui-message-stream", "v1");
    c.header("x-accel-buffering", "no");

    return stream(c, (stream) =>
      stream.pipe(
        dataStream
          .pipeThrough(new JsonToSseTransformStream())
          .pipeThrough(new TextEncoderStream()),
      ),
    );
  },
);

export default app;
