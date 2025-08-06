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
    mcpClients: (mcp: Config["mcp"]) =>
      [...queryKeys.config.all(), "mcp-clients", { mcp }] as const,
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
  models: {
    all: () => ["models"] as const,
  },
} as const;
