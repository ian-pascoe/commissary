import { useChat } from "@ai-sdk/react";
import { fetch } from "@tauri-apps/plugin-http";
import {
  type ChatOnFinishCallback,
  DefaultChatTransport,
  type UIMessage,
} from "ai";
import { GlobeIcon, MicIcon, PlusIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useMessages } from "~/hooks/use-conversations";
import { useMessageMutation } from "~/hooks/use-data-mutations";
import { useSync, useSyncStats } from "~/hooks/use-sync";
import { models } from "~/lib/models";
import type { Conversation } from "~/schemas/conversation";
import type { Message } from "~/schemas/messages";
import type { ModelId } from "~/schemas/model";
import {
  AIConversation,
  AIConversationContent,
} from "../ui/kibo-ui/ai/conversation";
import {
  AIInput,
  AIInputButton,
  AIInputModelSelect,
  AIInputModelSelectContent,
  AIInputModelSelectItem,
  AIInputModelSelectTrigger,
  AIInputModelSelectValue,
  AIInputSubmit,
  AIInputTextarea,
  AIInputToolbar,
  AIInputTools,
} from "../ui/kibo-ui/ai/input";
import { AIMessage, AIMessageContent } from "../ui/kibo-ui/ai/message";
import { AIResponse } from "../ui/kibo-ui/ai/response";
import { SelectGroup } from "../ui/select";
import { SyncStatusButton } from "./sync-status-button";

export type ConversationWindowProps = {
  conversation: Conversation; // Now required since it's created in route
  messages?: Message[]; // Initial messages can be passed if needed
};

export const ConversationWindow = (props: ConversationWindowProps) => {
  const [input, setInput] = useState("");
  const [model, setModel] = useState<ModelId>("google:gemini-2.5-flash-lite");

  // Fetch messages from the database
  const { data: dbMessages = [] } = useMessages(props.conversation.id);

  const messageMutation = useMessageMutation();
  const syncMutation = useSync();
  const syncStats = useSyncStats();

  // Save assistant messages to database using onFinish hook
  const handleMessageFinish: ChatOnFinishCallback<UIMessage> = useCallback(
    async ({ message }) => {
      try {
        await messageMutation.mutateAsync({
          id: message.id,
          conversationId: props.conversation.id,
          data: message,
        });

        // Trigger sync after message is saved (for assistant messages)
        if (message.role === "assistant") {
          setTimeout(() => {
            syncMutation.mutate({});
          }, 1000);
        }
      } catch (error) {
        console.error("Failed to save message:", error);
      }
    },
    [props.conversation.id, messageMutation, syncMutation],
  );

  const { messages, setMessages, sendMessage, status } = useChat({
    transport: new DefaultChatTransport({
      api: `${import.meta.env.VITE_API_URL}/chat`,
      fetch: fetch as typeof globalThis.fetch,
    }),
    messages: dbMessages,
    onError: (error) => {
      console.error("Chat error:", error);
    },
    onFinish: handleMessageFinish,
  });

  // Update chat messages when database messages change
  useEffect(() => {
    if (dbMessages.length > 0) {
      setMessages(dbMessages);
    }
  }, [dbMessages, setMessages]);
  // Save user message to database before sending
  const handleUserMessage = useCallback(
    async (
      userMessage: { text: string },
      options?: { body: { conversation: Conversation; modelId: string } },
    ) => {
      try {
        // Create and save user message
        const userMessageData = {
          role: "user" as const,
          parts: [{ type: "text" as const, text: userMessage.text }],
        };

        await messageMutation.mutateAsync({
          conversationId: props.conversation.id,
          data: userMessageData,
        });

        // Send message to AI
        sendMessage(userMessage, options);
      } catch (error) {
        console.error("Failed to save user message:", error);
        // Still send the message even if saving fails
        sendMessage(userMessage, options);
      }
    },
    [props.conversation.id, messageMutation, sendMessage],
  );

  return (
    <div className="relative flex size-full flex-col">
      {/* Sync status icon positioned in top right */}
      <SyncStatusButton
        syncStats={syncStats.data}
        isLoading={syncMutation.isPending}
        onManualSync={() => syncMutation.mutate({})}
      />
      <AIConversation className="relative flex flex-1">
        <AIConversationContent>
          {messages.map((message) => (
            <AIMessage
              key={message.id}
              from={message.role as "user" | "assistant"}
            >
              <AIMessageContent>
                {message.parts.map((part, index) => {
                  const key = `${message.id}-${index}`;
                  switch (part.type) {
                    case "text": {
                      return <AIResponse key={key}>{part.text}</AIResponse>;
                    }
                    default: {
                      return null;
                    }
                  }
                })}
              </AIMessageContent>
            </AIMessage>
          ))}
        </AIConversationContent>
      </AIConversation>
      <div className="flex justify-center px-2">
        <AIInput
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            handleUserMessage(
              { text: input },
              {
                body: {
                  conversation: props.conversation,
                  modelId: model,
                },
              },
            );
            setInput("");
          }}
        >
          <AIInputTextarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <AIInputToolbar>
            <AIInputTools>
              <AIInputButton>
                <PlusIcon size={16} />
              </AIInputButton>
              <AIInputButton>
                <MicIcon size={16} />
              </AIInputButton>
              <AIInputButton>
                <GlobeIcon size={16} />
                <span>Search</span>
              </AIInputButton>
              <AIInputModelSelect
                value={model}
                onValueChange={(v) => setModel(v as ModelId)}
              >
                <AIInputModelSelectTrigger>
                  <AIInputModelSelectValue />
                </AIInputModelSelectTrigger>
                <AIInputModelSelectContent>
                  {Object.entries(models).map(([provider, models]) => (
                    <SelectGroup key={provider} title={provider}>
                      {models.map((model) => (
                        <AIInputModelSelectItem
                          key={model}
                          value={`${provider}:${model}`}
                        >
                          {model}
                        </AIInputModelSelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </AIInputModelSelectContent>
              </AIInputModelSelect>
            </AIInputTools>
            <AIInputSubmit disabled={!input} status={status} />
          </AIInputToolbar>
        </AIInput>
      </div>
    </div>
  );
};
