import { zValidator } from "@hono/zod-validator";
import {
  convertToModelMessages,
  createUIMessageStream,
  JsonToSseTransformStream,
  smoothStream,
  streamText,
  type UIMessage,
} from "ai";
import { stream } from "hono/streaming";
import * as z from "zod";
import { Conversation } from "~/schemas/conversation";
import { RemoteModelId } from "~/schemas/model";
import {
  conversations,
  messages as messagesTable,
} from "~~/drizzle/remote/schema";
import { providerRegistry } from "../lib/provider-registry";
import { requireAuthMiddleware } from "../middleware/auth";
import { factory } from "../utils/factory";

const app = factory.createApp().post(
  "/",
  requireAuthMiddleware(),
  zValidator(
    "json",
    z.object({
      messages: z.array(z.custom<UIMessage>()),
      modelId: RemoteModelId,
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

    if (conversation && conversation.userId !== user.id) {
      return c.json({ error: "Unauthorized" }, 403);
    }

    // If conversation doesn't exist, create it using the client conversation data
    if (!conversation) {
      const [createdConversation] = await db
        .insert(conversations)
        .values({
          ...clientConversation,
          userId: user.id,
        })
        .onConflictDoUpdate({
          target: conversations.id,
          set: {
            ...clientConversation,
            updatedAt: new Date(),
          },
        })
        .returning();

      if (!createdConversation) {
        return c.json({ error: "Failed to create conversation" }, 500);
      }
      conversation = createdConversation;
    }

    const promises: Promise<unknown>[] = [
      db.batch(
        messages.map((msg) =>
          db
            .insert(messagesTable)
            .values({
              userId: user.id,
              conversationId: conversation.id,
              ...msg,
            })
            .onConflictDoUpdate({
              target: messagesTable.id,
              set: {
                ...msg,
                updatedAt: new Date(),
              },
            }),
        ) as any,
      ),
    ];

    const dataStream = createUIMessageStream({
      execute: ({ writer }) => {
        const result = streamText({
          model: providerRegistry().languageModel(modelId),
          messages: convertToModelMessages(messages),
          abortSignal: c.req.raw.signal,
          experimental_transform: [smoothStream()],
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
          }),
        );
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
