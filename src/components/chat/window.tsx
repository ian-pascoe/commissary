import { useChat } from "@ai-sdk/react";
import { fetch } from "@tauri-apps/plugin-http";
import { DefaultChatTransport } from "ai";
import { useMemo } from "react";
import {
  AIConversation,
  AIConversationContent,
} from "../ui/kibo-ui/ai/conversation";
import { AIMessage, AIMessageContent } from "../ui/kibo-ui/ai/message";
import { AIResponse } from "../ui/kibo-ui/ai/response";

export type ConversationWindowProps = {
  conversationId?: string;
};

export const ConversationWindow = (props: ConversationWindowProps) => {
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: `${import.meta.env.VITE_API_URL}/chat`,
        body: { conversationId: props.conversationId },
        fetch: fetch as typeof globalThis.fetch,
      }),
    [props.conversationId],
  );

  const { messages } = useChat({
    transport,
  });

  return (
    <div className="flex size-full">
      <AIConversation className="relative flex flex-1">
        <AIConversationContent>
          {messages.map((message) => (
            <AIMessage
              key={message.id}
              from={message.role as "user" | "assistant"}
            >
              {message.parts.map((part, index) => {
                const key = `${message.id}-${index}`;
                switch (part.type) {
                  case "text": {
                    return (
                      <AIMessageContent key={key}>
                        <AIResponse>{part.text}</AIResponse>
                      </AIMessageContent>
                    );
                  }
                  default: {
                    return null;
                  }
                }
              })}
            </AIMessage>
          ))}
        </AIConversationContent>
      </AIConversation>
    </div>
  );
};
