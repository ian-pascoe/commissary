import { useQuery } from "@tanstack/react-query";
import { useLocalDb } from "~/hooks/use-local-db";
import { queryKeys } from "~/lib/query-keys";
import type { Conversation } from "~/schemas/conversation";
import type { Message } from "~/schemas/messages";

export const useConversations = () => {
  const db = useLocalDb();

  return useQuery({
    queryKey: queryKeys.conversations.list(),
    queryFn: async (): Promise<Conversation[]> => {
      if (!db) return [];

      const conversations = await db.query.conversations.findMany({
        where: (c, { eq }) => eq(c.isDeleted, false),
        orderBy: (c, { desc }) => desc(c.updatedAt),
      });

      return conversations;
    },
    enabled: !!db,
  });
};

export const useMessages = (conversationId: string) => {
  const db = useLocalDb();

  return useQuery({
    queryKey: queryKeys.messages.byConversation(conversationId),
    queryFn: async (): Promise<Message[]> => {
      if (!db) return [];

      const messages = await db.query.messages.findMany({
        where: (m, { eq, and }) =>
          and(eq(m.conversationId, conversationId), eq(m.isDeleted, false)),
        orderBy: (m, { asc }) => asc(m.createdAt),
      });

      return messages;
    },
    enabled: !!db && !!conversationId,
  });
};
