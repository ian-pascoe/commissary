import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "~/lib/query-keys";
import { useLocalDb } from "./use-local-db";

export const useMessages = (conversationId: string) => {
  const db = useLocalDb();

  return useQuery({
    queryKey: queryKeys.messages.byConversation(conversationId),
    queryFn: async () => {
      if (!db) return [];

      const messages = await db.query.messages.findMany({
        where: (m, { eq, and }) => and(eq(m.conversationId, conversationId)),
        orderBy: (m, { asc }) => asc(m.createdAt),
      });

      return messages;
    },
    enabled: !!db && !!conversationId,
  });
};
