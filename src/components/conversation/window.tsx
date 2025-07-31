import { Menu } from "lucide-react";
import { ChatProvider } from "~/contexts/chat";
import type { Conversation } from "~/schemas/conversation";
import type { Message } from "~/schemas/messages";
import { ThemeToggle } from "../theme/toggle";
import { SidebarTrigger } from "../ui/sidebar";
import { FileAttachments } from "./file-attachments";
import { ConversationInput } from "./input";
import { ConversationMessages } from "./messages";

export type ConversationWindowProps = {
  conversation?: Conversation;
  messages?: Message[];
};

export const ConversationWindow = (props: ConversationWindowProps) => {
  return (
    <ChatProvider conversation={props.conversation} messages={props.messages}>
      <div className="relative flex size-full flex-col">
        <div className="-translate-x-1/2 absolute inset-x-1/2 top-4 z-50 flex h-8 w-fit items-center rounded-full bg-primary/80 text-primary-foreground outline backdrop-blur-md">
          <SidebarTrigger
            variant="ghost"
            className="size-8 rounded-r-none rounded-l-full"
          >
            <Menu />
          </SidebarTrigger>
          <span className="w-fit max-w-lg truncate text-nowrap px-2 text-sm">
            {props.conversation?.title || "Unnamed Conversation"}
          </span>
          <ThemeToggle
            variant="ghost"
            size="icon"
            className="size-8 rounded-r-full rounded-l-none"
          />
        </div>
        <ConversationMessages />
        <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-2 px-2">
          <FileAttachments />
          <ConversationInput />
        </div>
      </div>
    </ChatProvider>
  );
};
