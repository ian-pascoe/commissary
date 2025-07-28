import { useChat } from "@ai-sdk/react";
import { useQueryClient } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { fetch } from "@tauri-apps/plugin-http";
import { DefaultChatTransport, type UIMessage } from "ai";
import { merge } from "es-toolkit";
import { GlobeIcon, PlusIcon } from "lucide-react";
import mime from "mime";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useGeneralStore } from "~/hooks/use-general-store";
import { useLocalDb } from "~/hooks/use-local-db";
import { useProviders } from "~/hooks/use-providers";
import { useStrongholdStore } from "~/hooks/use-stronghold";
import { providers } from "~/lib/providers";
import { queryKeys } from "~/lib/query-keys";
import { cn } from "~/lib/utils";
import type { Conversation } from "~/schemas/conversation";
import type { Message } from "~/schemas/messages";
import { LocalChatTransport } from "~/utils/local-chat-transport";
import {
  conversations as conversationsTable,
  messages as messagesTable,
} from "~~/drizzle/local/schema";
import {
  AIConversation,
  AIConversationContent,
  AIConversationScrollButton,
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
import { AISuggestion, AISuggestions } from "../ui/kibo-ui/ai/suggestion";
import { MicButton } from "./mic-button";

export type ConversationWindowProps = {
  conversation?: Conversation;
  messages?: Message[];
};

export const ConversationWindow = (props: ConversationWindowProps) => {
  const db = useLocalDb();
  const strongholdStore = useStrongholdStore();
  const generalStore = useGeneralStore();
  const { providers: configProviders = {} } = useProviders();
  const queryClient = useQueryClient();

  const conversationRef = useRef<Conversation>(undefined);
  useEffect(() => {
    conversationRef.current = props.conversation;
  }, [props.conversation]);

  const [isListening, setIsListening] = useState(false);
  const [input, setInput] = useState("");
  const [filePaths, setFilePaths] = useState<string[]>([]);
  const [model, setModel] = useState("google:gemini-2.5-flash");
  useEffect(() => {
    generalStore.get<string>("language-model").then((model) => {
      if (model) {
        setModel(model);
      }
    });
  }, [generalStore]);
  useEffect(() => {
    generalStore.set("language-model", model);
  }, [model, generalStore]);

  const transport = useMemo(() => {
    const [provider] = model.split(":");
    if (provider && Object.hasOwn(configProviders, provider)) {
      console.log(`Using LocalChatTransport for provider: ${provider}`);
      return new LocalChatTransport({
        providers: configProviders,
        strongholdStore,
      });
    }
    return new DefaultChatTransport({
      api: `${import.meta.env.VITE_API_URL}/chat`,
      fetch: fetch as typeof globalThis.fetch,
    });
  }, [model, configProviders, strongholdStore]);

  const { messages, setMessages, sendMessage, status } = useChat({
    transport,
    onFinish: async ({ message }) => {
      if (!conversationRef.current) {
        console.error("No conversation found or created.");
        return;
      }
      await db.insert(messagesTable).values({
        conversationId: conversationRef.current.id,
        ...message,
      });
    },
    onError: (error) => {
      console.error("Chat error:", error);
    },
  });
  useEffect(() => {
    setMessages(props.messages || []);
  }, [props.messages, setMessages]);

  const handleSubmit = useCallback(async () => {
    const currentInput = input;
    if (!currentInput.trim()) return;
    setInput("");

    const parts: UIMessage["parts"] = [
      { type: "text", text: currentInput.trim() },
    ];
    await Promise.all(
      filePaths.map(async (path) => {
        const fileContent = await readFile(path);
        const mediaType = mime.getType(path) || "text/plain";
        const base64Content = btoa(String.fromCharCode(...fileContent));
        parts.push({
          type: "file",
          filename: path.split("/").pop(),
          mediaType,
          url: `data:${mediaType};base64,${base64Content}`,
        });
      }),
    );

    let currentConversation = conversationRef.current;
    if (!currentConversation) {
      [currentConversation] = await db
        .insert(conversationsTable)
        .values({
          title: "New Conversation",
        })
        .returning();
      conversationRef.current = currentConversation;
    }
    queryClient.invalidateQueries({
      queryKey: queryKeys.conversations.all,
    });

    if (!currentConversation) {
      console.error("No conversation found or created.");
      return;
    }

    await Promise.all([
      db.insert(messagesTable).values({
        conversationId: currentConversation.id,
        role: "user",
        parts,
      }),
      sendMessage(
        { parts },
        {
          body: {
            conversation: conversationRef.current,
            modelId: model,
          },
        },
      ),
    ]);
  }, [input, db, queryClient, sendMessage, model, filePaths]);

  const resolvedProviders = useMemo(
    () => merge(providers, configProviders ?? {}),
    [configProviders],
  );

  return (
    <div className="relative flex size-full flex-col">
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
          <AIConversationScrollButton
            variant="default"
            className="bottom-32 z-50"
          />
          <div className="h-40" />
        </AIConversationContent>
      </AIConversation>
      <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-2 px-2">
        {Boolean(filePaths.length) && (
          <AISuggestions>
            {filePaths.map((path) => (
              <AISuggestion
                key={path}
                suggestion={path}
                onClick={(suggestion) => {
                  setFilePaths((prev) => prev.filter((p) => p !== suggestion));
                }}
              >
                {path.split("/").pop() || path}
              </AISuggestion>
            ))}
          </AISuggestions>
        )}
        <AIInput
          className={cn(
            "rounded-b-none bg-background/90 backdrop-blur-lg transition-all duration-200",
            isListening && "ring-2 ring-red-500/50",
          )}
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            handleSubmit();
          }}
        >
          <AIInputTextarea
            disabled={isListening}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              isListening ? "Listening..." : "Type your message here..."
            }
          />
          <AIInputToolbar>
            <AIInputTools>
              <AIInputButton
                onClick={async () => {
                  const filePaths = await open({
                    multiple: true,
                    directory: false,
                    filters: [
                      {
                        name: "PDFs, Text, Images",
                        extensions: ["pdf", "txt", "png", "jpg", "jpeg", "gif"],
                      },
                    ],
                  });
                  if (filePaths) {
                    setFilePaths(filePaths);
                  }
                }}
              >
                <PlusIcon size={16} />
              </AIInputButton>
              <MicButton
                setInput={setInput}
                onIsListeningChange={setIsListening}
              />
              <AIInputButton>
                <GlobeIcon size={16} />
                <span>Search</span>
              </AIInputButton>
              <AIInputModelSelect
                value={model}
                onValueChange={(v) => setModel(v)}
              >
                <AIInputModelSelectTrigger>
                  <AIInputModelSelectValue />
                </AIInputModelSelectTrigger>
                <AIInputModelSelectContent>
                  {Object.entries(resolvedProviders).map(
                    ([provider, { models = {} }]) =>
                      Object.entries(models).map(([modelId, { name }]) => (
                        <AIInputModelSelectItem
                          key={modelId}
                          value={`${provider}:${modelId}`}
                        >
                          {provider}:{name ?? modelId}
                        </AIInputModelSelectItem>
                      )),
                  )}
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
