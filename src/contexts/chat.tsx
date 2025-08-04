import { type UIMessage, useChat as useAiChat } from "@ai-sdk/react";
import { useQueryClient } from "@tanstack/react-query";
import { fetch } from "@tauri-apps/plugin-http";
import { type ChatTransport, DefaultChatTransport, type FileUIPart } from "ai";
import { toMerged } from "es-toolkit";
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
import { useMcpClients } from "~/hooks/use-mcp";
import { useMessages } from "~/hooks/use-messages";
import { useProvidersConfig } from "~/hooks/use-providers";
import { useStrongholdStore } from "~/hooks/use-stronghold";
import { preloadedProviders } from "~/lib/preloaded-providers";
import { queryKeys } from "~/lib/query-keys";
import type { ProviderConfig } from "~/schemas/config/provider";
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
  model: string;
  setModel: React.Dispatch<React.SetStateAction<string>>;
  fileData: FileData[];
  setFileData: React.Dispatch<React.SetStateAction<FileData[]>>;
  handleSubmit: React.FormEventHandler<HTMLFormElement>;
  resolvedProviders: Record<string, ProviderConfig>;
};

export const ChatContext = createContext<ChatContextType | null>(null);

export type ChatProviderProps = {
  conversation?: Conversation;
  messages?: UIMessage[];
  children: React.ReactNode;
};

export const ChatProvider = ({ children, ...props }: ChatProviderProps) => {
  const db = useLocalDb();
  const strongholdStore = useStrongholdStore();
  const config = useConfig();

  const { data: providersConfig } = useProvidersConfig();
  const resolvedProvidersConfig = useMemo(
    () => toMerged(preloadedProviders, providersConfig ?? {}),
    [providersConfig],
  );

  const { data: mcpClients } = useMcpClients();

  const queryClient = useQueryClient();

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
  const [model, setModel] = useState("google:gemini-2.5-flash");
  useEffect(() => {
    config.get().then((config) => {
      if (config.model) {
        setModel(config.model);
      }
    });
  }, [config]);
  useEffect(() => {
    config.merge({ model });
  }, [model, config]);

  const transportRef = useRef<ChatTransport<UIMessage>>(
    new DefaultChatTransport({
      api: `${import.meta.env.VITE_API_URL}/chat`,
      fetch: fetch as typeof globalThis.fetch,
    }),
  );
  useEffect(() => {
    const [provider] = model.split(":");
    if (provider && Object.hasOwn(providersConfig ?? {}, provider)) {
      transportRef.current = new LocalChatTransport({
        providersConfig: resolvedProvidersConfig,
        mcpClients,
      });
    } else {
      transportRef.current = new DefaultChatTransport({
        api: `${import.meta.env.VITE_API_URL}/chat`,
        fetch: fetch as typeof globalThis.fetch,
      });
    }
  }, [model, providersConfig, resolvedProvidersConfig, mcpClients]);

  const chat = useAiChat({
    transport: new DelegatingChatTransport({
      delegator: () => transportRef.current,
    }),
    onFinish: async ({ message }) => {
      const finishTime = performance.now();
      console.log(
        `[Performance] 🏁 Chat finished, onFinish called at ${finishTime}`,
      );

      if (!conversationRef.current) {
        console.error("No conversation found or created.");
        return;
      }
      await db.insert(messagesTable).values({
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
      const submitStartTime = performance.now();
      console.log(
        `[Performance] 📤 handleSubmit started at ${submitStartTime}`,
      );

      e.preventDefault();
      e.stopPropagation();

      const currentInput = input.trim();
      if (!currentInput) return;
      setInput("");

      const currentFileData = fileData;
      setFileData([]);

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
        queryKey: queryKeys.conversations.all(),
      });

      if (!currentConversation) {
        console.error("No conversation found or created.");
        return;
      }

      const sendMessageStart = performance.now();
      console.log(
        `[Performance] 🚀 About to call chat.sendMessage at ${sendMessageStart} (${(sendMessageStart - submitStartTime).toFixed(2)}ms from submit start)`,
      );

      const parts: UIMessage["parts"] = [{ type: "text", text: currentInput }];
      const fileParts = await Promise.all(
        currentFileData.map((data) => {
          return { type: "file", ...data } satisfies FileUIPart;
        }),
      );
      parts.push(...fileParts);
      await Promise.all([
        db
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
            headers: {
              Authorization: `Bearer ${await strongholdStore.get("auth-token")}`,
            },
            body: {
              conversation: currentConversation,
              modelId: model,
            },
          },
        ),
      ]);

      const sendMessageEnd = performance.now();
      console.log(
        `[Performance] 🎯 chat.sendMessage completed after ${(sendMessageEnd - sendMessageStart).toFixed(2)}ms (total handleSubmit: ${(sendMessageEnd - submitStartTime).toFixed(2)}ms)`,
      );
    },
    [
      input,
      db,
      queryClient,
      chat.sendMessage,
      model,
      fileData,
      strongholdStore,
    ],
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
      resolvedProviders: resolvedProvidersConfig,
    }),
    [
      chat,
      isListening,
      input,
      model,
      fileData,
      handleSubmit,
      resolvedProvidersConfig,
    ],
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
