import { useQuery } from "@tanstack/react-query";
import { useLocalDb } from "~/hooks/use-local-db";
import { queryKeys } from "~/lib/query-keys";

export const useConversations = () => {
  const db = useLocalDb();

  return useQuery({
    queryKey: queryKeys.conversations.all(),
    queryFn: async () => {
      if (!db) return [];

      const conversations = await db.query.conversations.findMany({
        orderBy: (c, { desc }) => desc(c.updatedAt),
      });

      return conversations;
    },
  });
};
