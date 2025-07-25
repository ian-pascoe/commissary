import { useMutation, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "~/lib/query-keys";
import type { CreateConversationInput } from "~/schemas/conversation";
import type { CreateMessageInput } from "~/schemas/messages";
import {
  conversations as conversationsTable,
  messages as messagesTable,
} from "~~/drizzle/local/schema";
import { useLocalDb } from "./use-local-db";

/**
 * Enhanced hooks for managing local data with automatic sync state management
 */

// Hook for creating/updating conversations with automatic dirty marking
export const useConversationMutation = () => {
  const db = useLocalDb();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      data,
    }: {
      id?: string;
      data: CreateConversationInput;
    }) => {
      const now = new Date();
      const values = {
        ...data,
        updatedAt: now,
        isDirty: true,
        ...(id && { id }), // Include id if provided
      };

      // Use insert with onConflictDoUpdate for upsert behavior
      const [result] = await db
        .insert(conversationsTable)
        .values(values)
        .onConflictDoUpdate({
          target: conversationsTable.id,
          set: {
            ...values,
            updatedAt: now,
            isDirty: true,
          },
        })
        .returning();

      return result;
    },
    onMutate: async ({ id, data }) => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({
        queryKey: queryKeys.conversations.all,
      });

      // Snapshot previous value
      const previousConversations = queryClient.getQueryData(
        queryKeys.conversations.list(),
      );

      // Optimistically update the cache
      queryClient.setQueryData(
        queryKeys.conversations.list(),
        (old: any[] = []) => {
          if (id) {
            // Update existing
            return old.map((conv) =>
              conv.id === id
                ? { ...conv, ...data, updatedAt: new Date() }
                : conv,
            );
          } else {
            // Add new
            const newConv = {
              id: `temp-${Date.now()}`, // Temporary ID
              ...data,
              createdAt: new Date(),
              updatedAt: new Date(),
              isDirty: true,
            };
            return [newConv, ...old];
          }
        },
      );

      return { previousConversations };
    },
    onError: (_err, _variables, context) => {
      // Rollback on error
      if (context?.previousConversations) {
        queryClient.setQueryData(
          queryKeys.conversations.list(),
          context.previousConversations,
        );
      }
    },
    onSuccess: (data) => {
      // Update with real data
      queryClient.setQueryData(
        queryKeys.conversations.list(),
        (old: any[] = []) => {
          return old.map((conv) =>
            conv.id === data?.id || conv.id.startsWith("temp-") ? data : conv,
          );
        },
      );

      // Invalidate sync stats to show pending changes
      queryClient.invalidateQueries({ queryKey: queryKeys.sync.stats() });
    },
  });
};

// Hook for creating/updating messages with automatic dirty marking
export const useMessageMutation = () => {
  const db = useLocalDb();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      conversationId,
      data,
    }: {
      id?: string;
      conversationId: string;
      data: CreateMessageInput;
    }) => {
      const now = new Date();
      const values = {
        ...data,
        conversationId,
        updatedAt: now,
        isDirty: true,
        ...(id && { id }), // Include id if provided
      };

      // Use insert with onConflictDoUpdate for upsert behavior
      const [result] = await db
        .insert(messagesTable)
        .values(values)
        .onConflictDoUpdate({
          target: messagesTable.id,
          set: {
            ...values,
            updatedAt: now,
            isDirty: true,
          },
        })
        .returning();

      return result;
    },
    onMutate: async ({ id, conversationId, data }) => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({
        queryKey: queryKeys.messages.byConversation(conversationId),
      });

      // Snapshot previous value
      const previousMessages = queryClient.getQueryData(
        queryKeys.messages.byConversation(conversationId),
      );

      // Optimistically update the cache
      queryClient.setQueryData(
        queryKeys.messages.byConversation(conversationId),
        (old: any[] = []) => {
          if (id) {
            // Update existing
            return old.map((msg) =>
              msg.id === id ? { ...msg, ...data, updatedAt: new Date() } : msg,
            );
          } else {
            // Add new
            const newMsg = {
              id: `temp-${Date.now()}`, // Temporary ID
              conversationId,
              ...data,
              createdAt: new Date(),
              updatedAt: new Date(),
              isDirty: true,
            };
            return [...old, newMsg];
          }
        },
      );

      return { previousMessages };
    },
    onError: (_err, variables, context) => {
      // Rollback on error
      if (context?.previousMessages) {
        queryClient.setQueryData(
          queryKeys.messages.byConversation(variables.conversationId),
          context.previousMessages,
        );
      }
    },
    onSuccess: (data, variables) => {
      // Update with real data
      queryClient.setQueryData(
        queryKeys.messages.byConversation(variables.conversationId),
        (old: any[] = []) => {
          return old.map((msg) =>
            msg.id === data?.id || msg.id.startsWith("temp-") ? data : msg,
          );
        },
      );

      // Invalidate sync stats to show pending changes
      queryClient.invalidateQueries({ queryKey: queryKeys.sync.stats() });
    },
  });
};
