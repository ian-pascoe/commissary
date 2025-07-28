import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { eq } from "drizzle-orm";
import { MessageSquarePlusIcon, PlusIcon, Settings, Trash } from "lucide-react";
import { Button } from "~/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "~/components/ui/sidebar";
import { useConversations } from "~/hooks/use-conversations";
import { useLocalDb } from "~/hooks/use-local-db";
import { conversations as conversationsTable } from "~~/drizzle/local/schema";

export function ConversationsSidebar() {
  const navigate = useNavigate();
  const { id: currentConversationId } = useParams({ strict: false });

  const db = useLocalDb();
  const { data: conversations, isLoading, refetch } = useConversations();

  const deleteMutation = useMutation({
    mutationFn: async (conversationId: string) => {
      await db
        .delete(conversationsTable)
        .where(eq(conversationsTable.id, conversationId));
      return conversationId;
    },
    onSuccess: (conversationId) => {
      if (currentConversationId === conversationId) {
        navigate({ to: "/chat" });
      }
    },
    onSettled: () => refetch(),
  });

  return (
    <Sidebar>
      <SidebarHeader className="border-sidebar-border border-b">
        <Button asChild className="w-full justify-start gap-2">
          <Link to="/chat">
            <PlusIcon size={16} />
            New Conversation
          </Link>
        </Button>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="flex items-center gap-2">
            <MessageSquarePlusIcon size={16} />
            Recent Conversations
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {isLoading ? (
                // Loading skeleton
                Array.from({ length: 5 }).map((_, i) => (
                  <SidebarMenuItem key={`loading-${i}`}>
                    <div className="flex h-8 items-center gap-2 rounded-md px-2">
                      <div className="h-4 w-full animate-pulse rounded bg-sidebar-accent/50" />
                    </div>
                  </SidebarMenuItem>
                ))
              ) : conversations?.length ? (
                conversations.map((conversation) => (
                  <SidebarMenuItem
                    key={conversation.id}
                    className="flex items-center justify-between"
                  >
                    <SidebarMenuButton
                      asChild
                      isActive={currentConversationId === conversation.id}
                      className="flex-1"
                    >
                      <Link to="/chat/$id" params={{ id: conversation.id }}>
                        <span className="truncate">
                          {conversation.title || "Untitled Conversation"}
                        </span>
                      </Link>
                    </SidebarMenuButton>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => deleteMutation.mutate(conversation.id)}
                    >
                      <Trash />
                    </Button>
                  </SidebarMenuItem>
                ))
              ) : (
                <SidebarMenuItem>
                  <div className="px-2 py-1 text-sidebar-foreground/60 text-sm">
                    No conversations yet
                  </div>
                </SidebarMenuItem>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <Button variant="ghost" className="w-full justify-start gap-2" asChild>
          <Link to="/settings">
            <Settings size={16} />
            Settings
          </Link>
        </Button>
      </SidebarFooter>
    </Sidebar>
  );
}
