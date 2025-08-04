import { UserButton } from "@daveyplate/better-auth-ui";
import { Link, useBlocker, useParams } from "@tanstack/react-router";
import {
  DoorOpen,
  Edit,
  MessageSquarePlusIcon,
  PlusIcon,
  Settings,
  Trash,
} from "lucide-react";
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
  useSidebar,
} from "~/components/ui/sidebar";
import { useUser } from "~/hooks/use-auth";
import { useConversations } from "~/hooks/use-conversations";
import { DeleteConversationButton } from "./delete-button";
import { EditConversationButton } from "./edit-button";

export function ConversationsSidebar() {
  const user = useUser();
  const { id: currentConversationId } = useParams({ strict: false });

  const { data: conversations, status, refetch } = useConversations();

  const { isMobile, setOpenMobile } = useSidebar();
  useBlocker({
    shouldBlockFn: () => {
      if (isMobile) {
        setOpenMobile(false);
        document.body.style.pointerEvents = "";
      }
      return false;
    },
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
              {status === "pending" ? (
                // Loading skeleton
                Array.from({ length: 5 }).map((_, i) => (
                  <SidebarMenuItem key={`loading-${i}`}>
                    <div className="flex h-8 items-center gap-2 rounded-md px-2">
                      <div className="h-4 w-full animate-pulse rounded bg-sidebar-accent/50" />
                    </div>
                  </SidebarMenuItem>
                ))
              ) : status === "error" ? (
                <SidebarMenuItem>
                  <div className="px-2 py-1 text-red-500 text-sm">
                    Error loading conversations
                  </div>
                </SidebarMenuItem>
              ) : status === "success" ? (
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
                    <div className="flex items-center">
                      <EditConversationButton
                        size="icon"
                        variant="ghost"
                        conversationId={conversation.id}
                        currentTitle={conversation.title}
                        onSuccess={() => refetch()}
                      >
                        <Edit size={16} />
                      </EditConversationButton>
                      <DeleteConversationButton
                        size="icon"
                        variant="ghost"
                        conversationId={conversation.id}
                        onSuccess={() => refetch()}
                      >
                        <Trash size={16} />
                      </DeleteConversationButton>
                    </div>
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
        <SidebarMenu>
          {!user || user.isAnonymous ? (
            <>
              <SidebarMenuItem>
                <SidebarMenuButton asChild>
                  <Link to="/auth/$pathname" params={{ pathname: "sign-in" }}>
                    <DoorOpen size={16} />
                    Sign In
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild>
                  <Link to="/settings">
                    <Settings size={16} />
                    Settings
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </>
          ) : (
            <UserButton size="default" variant="ghost" />
          )}
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
