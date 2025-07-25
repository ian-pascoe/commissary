import { createFileRoute } from "@tanstack/react-router";
import { ConversationsSidebar } from "~/components/conversation/sidebar";
import { ConversationWindow } from "~/components/conversation/window";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "~/components/ui/sidebar";
import { conversations } from "~~/drizzle/local/schema";

export const Route = createFileRoute("/")({
  beforeLoad: async ({ context: { db } }) => {
    const [conversation] = await db
      .insert(conversations)
      .values({
        title: "New Conversation",
        // Mark as dirty so it gets synced to server
        isDirty: true,
        isDeleted: false,
        lastSyncedAt: null, // Will be set when synced
      })
      .returning();

    if (!conversation) {
      throw new Error("Failed to create conversation");
    }

    return { conversation };
  },
  component: RouteComponent,
});

function RouteComponent() {
  const conversation = Route.useRouteContext({
    select: (ctx) => ctx.conversation,
  });
  return (
    <SidebarProvider className="relative flex size-full">
      <ConversationsSidebar />
      <SidebarInset>
        <SidebarTrigger className="absolute top-4 left-4 z-10" />
        <ConversationWindow conversation={conversation} />
      </SidebarInset>
    </SidebarProvider>
  );
}
