import { createFileRoute, notFound, Outlet } from "@tanstack/react-router";
import * as z from "zod";
import { ConversationsSidebar } from "~/components/conversation/sidebar";
import { SidebarInset, SidebarProvider } from "~/components/ui/sidebar";
import { ChatProvider } from "~/contexts/chat";

export const Route = createFileRoute("/_chat")({
  params: z.object({
    id: z.optional(z.string()),
  }),
  beforeLoad: async ({ context: { localDb }, params }) => {
    const conversationId = params.id;

    if (conversationId) {
      const [conversation, messages] = await Promise.all([
        localDb.query.conversations.findFirst({
          where: (c, { eq }) => eq(c.id, conversationId),
        }),
        localDb.query.messages.findMany({
          where: (m, { eq }) => eq(m.conversationId, conversationId),
          orderBy: (m, { asc }) => asc(m.createdAt),
        }),
      ]);

      if (!conversation) {
        throw notFound();
      }

      return { conversation, messages };
    }
    return {};
  },
  component: RouteComponent,
});

function RouteComponent() {
  const { conversation, messages } = Route.useRouteContext();
  return (
    <ChatProvider conversation={conversation} messages={messages}>
      <SidebarProvider className="relative flex size-full">
        <ConversationsSidebar />
        <SidebarInset>
          <Outlet />
        </SidebarInset>
      </SidebarProvider>
    </ChatProvider>
  );
}
