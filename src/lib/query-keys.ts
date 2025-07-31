/**
 * Query keys for TanStack Query
 * Centralized location for all query keys to ensure consistency
 */

export const queryKeys = {
  // Auth queries
  session: ["session"] as const,
  providers: {
    all: ["providers"] as const,
  },
  conversations: {
    all: ["conversations"] as const,
    list: () => [...queryKeys.conversations.all, "list"] as const,
    detail: (id: string) =>
      [...queryKeys.conversations.all, "detail", id] as const,
  },
  messages: {
    all: ["messages"] as const,
    list: () => [...queryKeys.messages.all, "list"] as const,
    byConversation: (conversationId: string) =>
      [...queryKeys.messages.all, "conversation", conversationId] as const,
  },
} as const;
