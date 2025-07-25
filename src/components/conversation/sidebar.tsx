import { Link, useParams } from "@tanstack/react-router";
import { MessageSquarePlusIcon, PlusIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "~/components/ui/sidebar";
import { useConversations } from "~/hooks/use-conversations";

export function ConversationsSidebar() {
  const { data: conversations, isLoading } = useConversations();
  const params = useParams({ strict: false });
  const currentConversationId = params.id;

  return (
    <Sidebar>
      <SidebarHeader className="border-sidebar-border border-b">
        <Button asChild className="w-full justify-start gap-2">
          <Link to="/">
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
                  <SidebarMenuItem key={conversation.id}>
                    <SidebarMenuButton
                      asChild
                      isActive={currentConversationId === conversation.id}
                    >
                      <Link to="/$id" params={{ id: conversation.id }}>
                        <span className="truncate">
                          {conversation.title || "Untitled Conversation"}
                        </span>
                      </Link>
                    </SidebarMenuButton>
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
    </Sidebar>
  );
}
