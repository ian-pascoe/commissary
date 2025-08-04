/**
 * Query keys for TanStack Query
 * Centralized location for all query keys to ensure consistency
 */

import type { Config } from "~/schemas/config";

export const queryKeys = {
  // Auth queries
  session: { all: () => ["session"] as const },
  config: {
    all: () => ["config"] as const,
    providers: {
      all: () => [...queryKeys.config.all(), "providers"] as const,
    },
    mcp: {
      all: () => [...queryKeys.config.all(), "mcp"] as const,
      clients: (config: Config["mcp"]) =>
        [...queryKeys.config.mcp.all(), "clients", config] as const,
    },
  },
  conversations: {
    all: () => ["conversations"] as const,
    byId: (id: string) => [...queryKeys.conversations.all(), { id }] as const,
  },
  messages: {
    all: () => ["messages"] as const,
    byConversation: (conversationId: string) =>
      [...queryKeys.messages.all(), { conversationId }] as const,
  },
} as const;
