import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatISO, parseISO } from "date-fns";
import { eq } from "drizzle-orm";
import { queryKeys } from "~/lib/query-keys";
import { Conversation } from "~/schemas/conversation";
import { Message } from "~/schemas/messages";
import { getDirtyRecordsCount, getSyncStats } from "~/utils/sync";
import {
  conversations as conversationsTable,
  messages as messagesTable,
} from "~~/drizzle/local/schema";
import { useApiClient } from "./use-api-client";
import { useLocalDb } from "./use-local-db";
import { useStore } from "./use-store";

export type SyncError = {
  message: string;
  code?: string;
  retryable: boolean;
};

export type SyncResult = {
  conversations: Conversation[];
  messages: Message[];
  syncedAt: string;
};

export type SyncInput = {
  forceFullSync?: boolean;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const withRetry = async <T>(
  operation: () => Promise<T>,
  maxRetries = 3,
  baseDelay = 1000,
): Promise<T> => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === maxRetries) throw error;

      const delay = baseDelay * 2 ** (attempt - 1);
      await sleep(delay);
    }
  }
  throw new Error("Max retries exceeded");
};

export const useSync = () => {
  const store = useStore();
  const db = useLocalDb();
  const api = useApiClient();
  const queryClient = useQueryClient();

  const syncMutation = useMutation({
    mutationKey: ["sync"],
    mutationFn: async ({
      forceFullSync = false,
    }: SyncInput = {}): Promise<SyncResult> => {
      const lastSyncAt = await store.get<string>("last-sync-at");

      // Delta sync: Only get dirty (changed) records unless force full sync
      const [dirtyConversations, dirtyMessages] = await db.batch([
        forceFullSync
          ? db.select().from(conversationsTable)
          : db
              .select()
              .from(conversationsTable)
              .where(eq(conversationsTable.isDirty, true)),
        forceFullSync
          ? db.select().from(messagesTable)
          : db
              .select()
              .from(messagesTable)
              .where(eq(messagesTable.isDirty, true)),
      ]);

      const syncTimestamp = new Date();

      const result = await withRetry(() =>
        api.sync.$post({
          json: {
            lastSyncAt: lastSyncAt ? parseISO(lastSyncAt) : new Date(0),
            data: {
              conversations: dirtyConversations,
              messages: dirtyMessages,
            },
          },
        }),
      );

      const data = await result.json();

      // Check if response is an error
      if ("error" in data) {
        throw new Error(data.message || "Sync failed");
      }

      const promises: Promise<unknown>[] = [];

      // Handle incoming conversations with conflict resolution
      if (data.conversations?.length) {
        promises.push(
          db.batch(
            data.conversations.map((c) => {
              const values = {
                ...c,
                createdAt: parseISO(c.createdAt),
                updatedAt: parseISO(c.updatedAt),
                lastSyncedAt: c.lastSyncedAt
                  ? parseISO(c.lastSyncedAt)
                  : parseISO(c.updatedAt),
                isDirty: false,
              };

              return db
                .insert(conversationsTable)
                .values(values)
                .onConflictDoUpdate({
                  target: conversationsTable.id,
                  set: {
                    // Last-write-wins conflict resolution
                    title: c.title,
                    updatedAt: parseISO(c.updatedAt),
                    lastSyncedAt: c.lastSyncedAt
                      ? parseISO(c.lastSyncedAt)
                      : parseISO(c.updatedAt),
                    isDirty: false,
                  },
                });
            }) as any,
          ),
        );
      }

      // Handle incoming messages with conflict resolution
      if (data.messages?.length) {
        promises.push(
          db.batch(
            data.messages.map((m: any) => {
              const values = {
                ...m,
                createdAt: parseISO(m.createdAt),
                updatedAt: parseISO(m.updatedAt),
                lastSyncedAt: m.lastSyncedAt
                  ? parseISO(m.lastSyncedAt)
                  : parseISO(m.updatedAt),
                isDirty: false,
              };

              return db
                .insert(messagesTable)
                .values(values)
                .onConflictDoUpdate({
                  target: messagesTable.id,
                  set: {
                    // Last-write-wins conflict resolution
                    role: m.role,
                    parts: m.parts,
                    updatedAt: parseISO(m.updatedAt),
                    lastSyncedAt: m.lastSyncedAt
                      ? parseISO(m.lastSyncedAt)
                      : parseISO(m.updatedAt),
                    isDirty: false,
                  },
                });
            }) as any,
          ),
        );
      }

      // Mark uploaded records as clean (only if we have records to update)
      if (dirtyConversations.length) {
        const conversationUpdates = dirtyConversations.map((c) =>
          db
            .update(conversationsTable)
            .set({
              isDirty: false,
              lastSyncedAt: syncTimestamp,
            })
            .where(eq(conversationsTable.id, c.id)),
        );
        promises.push(db.batch(conversationUpdates as any));
      }

      if (dirtyMessages.length) {
        const messageUpdates = dirtyMessages.map((m) =>
          db
            .update(messagesTable)
            .set({
              isDirty: false,
              lastSyncedAt: syncTimestamp,
            })
            .where(eq(messagesTable.id, m.id)),
        );
        promises.push(db.batch(messageUpdates as any));
      }

      // Update last sync timestamp
      promises.push(store.set("last-sync-at", formatISO(syncTimestamp)));

      await Promise.all(promises);

      return {
        conversations: Conversation.array().parse(data.conversations),
        messages: Message.array().parse(data.messages),
        syncedAt: syncTimestamp.toISOString(),
      };
    },
    onSuccess: (data) => {
      // Invalidate relevant queries after successful sync
      queryClient.invalidateQueries({ queryKey: queryKeys.conversations.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.messages.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.sync.stats() });

      // Optionally update specific queries with new data
      if (data.conversations.length > 0) {
        queryClient.setQueryData(
          queryKeys.conversations.list(),
          (oldData: any) => {
            if (!oldData) return data.conversations;

            // Merge new conversations with existing ones
            const existingIds = new Set(oldData.map((c: any) => c.id));
            const newConversations = data.conversations.filter(
              (c) => !existingIds.has(c.id),
            );

            return [...oldData, ...newConversations];
          },
        );
      }
    },
    onError: (error) => {
      console.error("Sync failed:", error);
    },
    retry: false, // We handle retries manually with withRetry
  });

  return syncMutation;
};

// Query hook for sync statistics
export const useSyncStats = () => {
  const db = useLocalDb();

  return useQuery({
    queryKey: queryKeys.sync.stats(),
    queryFn: () => getSyncStats(db),
    staleTime: 1000 * 30, // 30 seconds
    refetchInterval: 1000 * 60, // 1 minute
  });
};

// Query hook for dirty records count
export const useDirtyRecordsCount = () => {
  const db = useLocalDb();

  return useQuery({
    queryKey: queryKeys.sync.status(),
    queryFn: () => getDirtyRecordsCount(db),
    staleTime: 1000 * 10, // 10 seconds
    refetchInterval: 1000 * 30, // 30 seconds
  });
};
