import { zValidator } from "@hono/zod-validator";
import { createUIMessageStream, type UIMessage } from "ai";
import * as z from "zod";
import {
  conversations,
  messages as messagesTable,
} from "~/drizzle/remote/schema";
import type { Conversation } from "~/schemas/conversation";
import { factory } from "../utils/factory";

const app = factory.createApp().post(
  "/chat",
  zValidator(
    "json",
    z.object({
      messages: z.array(z.custom<UIMessage>()),
      conversationId: z.string().optional(),
    }),
  ),
  async (c) => {
    const { messages, conversationId } = c.req.valid("json");
    const db = c.get("db");

    let conversation: Conversation;
    if (conversationId) {
      const foundConversation = await db.query.conversations.findFirst({
        where: (c, { eq }) => eq(c.id, conversationId),
      });
      if (!foundConversation) {
        return c.json({ error: "Conversation not found" }, 404);
      }
      conversation = foundConversation;
    } else {
      const [createdConversation] = await db
        .insert(conversations)
        .values({
          title: "New Conversation",
        })
        .returning();
      if (!createdConversation) {
        return c.json({ error: "Failed to create conversation" }, 500);
      }
      conversation = createdConversation;
    }

    const dataStream = createUIMessageStream({
      execute: ({ writer }) => {},
      onFinish: ({ responseMessage }) => {
        promises.push(
          db.insert(messagesTable).values({
            userId: c.get("userId"),
            conversationId: conversation.id,
            ...responseMessage,
          }),
        );
      },
    });

    const promises: Promise<unknown>[] = [];

    c.executionCtx.waitUntil(Promise.all(promises));
  },
);

export default app;
