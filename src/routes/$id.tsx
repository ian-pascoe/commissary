import { createFileRoute, notFound } from "@tanstack/react-router";
import { ConversationsSidebar } from "~/components/conversation/sidebar";
import { ConversationWindow } from "~/components/conversation/window";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "~/components/ui/sidebar";

export const Route = createFileRoute("/$id")({
  beforeLoad: async ({ context: { db }, params }) => {
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
  const { conversation, messages } = Route.useRouteContext({
    select: (ctx) => ({
      conversation: ctx.conversation,
      messages: ctx.messages,
    }),
  });
  return (
    <SidebarProvider className="relative flex size-full">
      <ConversationsSidebar />
      <SidebarInset>
        <SidebarTrigger className="absolute top-4 left-4 z-10" />
        <ConversationWindow conversation={conversation} messages={messages} />
      </SidebarInset>
    </SidebarProvider>
  );
}
