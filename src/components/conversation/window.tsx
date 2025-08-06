import { Menu } from "lucide-react";
import { useChat } from "~/contexts/chat";
import { cn } from "~/lib/utils";
import { SidebarTrigger } from "../ui/sidebar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { ConversationFilesTable } from "./files-table";
import { ConversationInput } from "./input";
import { ConversationMessages } from "./messages";

export const ConversationWindow = () => {
  const { conversation, messages } = useChat((ctx) => ({
    conversation: ctx.conversation,
    messages: ctx.messages,
  }));
  return (
    <div className="relative flex size-full flex-col overflow-hidden">
      <Tabs
        className="flex size-full flex-1 flex-col overflow-hidden"
        defaultValue="messages"
      >
        <div className="flex items-center border-b">
          <div className="flex flex-1 items-center gap-2 pl-2">
            <SidebarTrigger variant="ghost" size="icon">
              <Menu />
            </SidebarTrigger>
            <div className="flex-1 truncate py-2 font-semibold text-lg">
              {conversation?.title || "New Conversation"}
            </div>
          </div>
          <TabsList className="h-full rounded-b-none">
            <TabsTrigger value="messages">Messages</TabsTrigger>
            <TabsTrigger value="files">Files</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent
          value="messages"
          className="relative flex size-full flex-1 flex-col overflow-hidden"
        >
          <ConversationMessages className="size-full flex-1 overflow-y-auto" />
          <div
            className={cn(
              "absolute inset-x-0 bottom-0 flex flex-col items-center gap-2 px-2 transition-all duration-300 ease-in-out",
              messages.length === 0 &&
                "-translate-y-1/2 inset-x-1/10 inset-y-1/2 h-fit",
            )}
          >
            {messages.length === 0 && (
              <div className="text-muted-foreground text-sm">
                Start the conversation by sending a message.
              </div>
            )}
            <ConversationInput />
          </div>
        </TabsContent>
        <TabsContent
          value="files"
          className="relative flex size-full flex-1 flex-col overflow-hidden"
        >
          <ConversationFilesTable />
        </TabsContent>
      </Tabs>
    </div>
  );
};
