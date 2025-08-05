import { useQuery } from "@tanstack/react-query";
import type { UIMessage } from "ai";
import { queryKeys } from "~/lib/query-keys";
import { useLocalDb } from "./use-local-db";

export const useMessages = (
  conversationId: string | undefined,
  options: {
    initialMessages?: UIMessage[];
  } = {},
) => {
  const db = useLocalDb();

  return useQuery({
    queryKey: queryKeys.messages.byConversation(conversationId ?? "unknown"),
    queryFn: async () => {
      if (!conversationId) return [];

      const messages = await db.query.messages.findMany({
        where: (m, { eq, and }) => and(eq(m.conversationId, conversationId)),
        orderBy: (m, { asc }) => asc(m.createdAt),
      });

      return messages;
    },
    enabled: !!conversationId,
    initialData: options.initialMessages,
  });
};
