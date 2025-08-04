import { type UIMessage, useChat as useAiChat } from "@ai-sdk/react";
import { useQueryClient } from "@tanstack/react-query";
import {
  type FileUIPart,
  lastAssistantMessageIsCompleteWithToolCalls,
} from "ai";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { useConfig } from "~/hooks/use-config";
import { useLocalDb } from "~/hooks/use-local-db";
import { useMcpClients, useMcpConfig } from "~/hooks/use-mcp";
import { useMessages } from "~/hooks/use-messages";
import { useProvidersConfig } from "~/hooks/use-providers";
import { queryKeys } from "~/lib/query-keys";
import type { Conversation } from "~/schemas/conversation";
import { DelegatingChatTransport } from "~/utils/chat-transport/delegating";
import { LocalChatTransport } from "~/utils/chat-transport/local";
import {
  conversations as conversationsTable,
  messages as messagesTable,
} from "~~/drizzle/local/schema";

export type FileData = Omit<FileUIPart, "type"> & { path: string };

export type ChatContextType = ReturnType<typeof useAiChat> & {
  isListening: boolean;
  setIsListening: React.Dispatch<React.SetStateAction<boolean>>;
  input: string;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  model: string | undefined;
  setModel: React.Dispatch<React.SetStateAction<string | undefined>>;
  fileData: FileData[];
  setFileData: React.Dispatch<React.SetStateAction<FileData[]>>;
  handleSubmit: React.FormEventHandler<HTMLFormElement>;
};

export const ChatContext = createContext<ChatContextType | null>(null);

export type ChatProviderProps = {
  conversation?: Conversation;
  messages?: UIMessage[];
  children: React.ReactNode;
};

export const ChatProvider = ({ children, ...props }: ChatProviderProps) => {
  const localDb = useLocalDb();
  const config = useConfig();

  const { data: providersConfig } = useProvidersConfig();

  const { data: mcpConfig } = useMcpConfig();
  const { data: mcpClients } = useMcpClients();
  useEffect(() => {
    console.log("MCP clients updated:", mcpClients);
    return () => {
      for (const client of Object.values(mcpClients ?? {})) {
        client.close().catch((err) => {
          console.error("Error closing MCP client:", err);
        });
      }
    };
  }, [mcpClients]);

  const conversationRef = useRef<Conversation | undefined>(props.conversation);
  useEffect(() => {
    conversationRef.current = props.conversation;
  }, [props.conversation]);

  const { data: dbMessages } = useMessages(conversationRef.current?.id, {
    initialMessages: props.messages,
  });

  const [isListening, setIsListening] = useState(false);
  const [input, setInput] = useState("");
  const [fileData, setFileData] = useState<FileData[]>([]);
  const [model, setModel] = useState<string | undefined>(undefined);
  useEffect(() => {
    config.get().then((config) => {
      if (config.model) {
        setModel(config.model);
      }
    });
  }, [config]);
  useEffect(() => {
    if (model) {
      config.merge({ model });
    }
  }, [model, config]);

  const queryClient = useQueryClient();

  const transportRef = useRef<LocalChatTransport<UIMessage>>(null);
  useEffect(() => {
    transportRef.current = new LocalChatTransport({
      providersConfig,
      mcpClients,
      mcpConfig,
    });
  }, [providersConfig, mcpClients, mcpConfig]);

  const chat = useAiChat({
    transport: new DelegatingChatTransport({
      delegator: () => {
        if (!transportRef.current) {
          throw new Error("Chat transport not initialized");
        }
        return transportRef.current;
      },
    }),
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    onFinish: async ({ message }) => {
      if (!conversationRef.current) {
        console.error("No conversation found or created.");
        return;
      }
      await localDb.insert(messagesTable).values({
        conversationId: conversationRef.current.id,
        ...message,
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.messages.byConversation(conversationRef.current.id),
      });
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });
  useEffect(() => {
    chat.setMessages(dbMessages || []);
  }, [dbMessages, chat.setMessages]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const currentInput = input.trim();
      if (!currentInput) {
        toast.error("Please enter a message");
        return;
      }
      setInput("");

      const currentFileData = fileData;
      setFileData([]);

      let currentConversation = conversationRef.current;
      if (!currentConversation) {
        [currentConversation] = await localDb
          .insert(conversationsTable)
          .values({ title: "New Conversation" })
          .returning();
        conversationRef.current = currentConversation;
      }
      queryClient.invalidateQueries({
        queryKey: queryKeys.conversations.all(),
      });

      if (!currentConversation) {
        console.error("No conversation found or created.");
        return;
      }

      const parts: UIMessage["parts"] = [{ type: "text", text: currentInput }];
      const fileParts = await Promise.all(
        currentFileData.map((data) => {
          return { type: "file", ...data } satisfies FileUIPart;
        }),
      );
      parts.push(...fileParts);
      await Promise.all([
        localDb
          .insert(messagesTable)
          .values({
            conversationId: currentConversation.id,
            role: "user",
            parts,
          })
          .then(() => {
            queryClient.invalidateQueries({
              queryKey: queryKeys.messages.byConversation(
                currentConversation.id,
              ),
            });
          }),
        chat.sendMessage(
          { parts },
          {
            body: {
              conversation: currentConversation,
              modelId: model ?? "google:gemini-2.5-flash-lite",
            },
          },
        ),
      ]);
    },
    [input, localDb, queryClient, chat.sendMessage, model, fileData],
  );

  const value = useMemo(
    () => ({
      ...chat,
      isListening,
      setIsListening,
      input,
      setInput,
      model,
      setModel,
      fileData,
      setFileData,
      handleSubmit,
    }),
    [chat, isListening, input, model, fileData, handleSubmit],
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
};

export function useChat<T = ChatContextType>(
  selector?: (state: ChatContextType) => T,
) {
  const ctx = useContext(ChatContext);
  if (!ctx) {
    throw new Error("useChat must be used within a ChatProvider");
  }
  const value = selector ? selector(ctx) : ctx;
  return useMemo(() => value as T, [value]);
}
