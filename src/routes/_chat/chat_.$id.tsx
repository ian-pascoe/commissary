import { createFileRoute, notFound } from "@tanstack/react-router";
import { ConversationWindow } from "~/components/conversation/window";

export const Route = createFileRoute("/_chat/chat_/$id")({
  loader: async ({ context: { db }, params }) => {
    const conversationId = params.id;

    const [conversation, messages] = await Promise.all([
      db.query.conversations.findFirst({
        where: (c, { eq }) => eq(c.id, conversationId),
      }),
      db.query.messages.findMany({
        where: (m, { eq }) => eq(m.conversationId, conversationId),
        orderBy: (m, { asc }) => asc(m.createdAt),
      }),
    ]);

    if (!conversation) {
      throw notFound();
    }

    return { conversation, messages };
  },
  component: RouteComponent,
});

function RouteComponent() {
  const { conversation, messages } = Route.useLoaderData();
  return <ConversationWindow conversation={conversation} messages={messages} />;
}
