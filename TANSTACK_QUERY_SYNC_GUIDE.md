# TanStack Query Sync Refactor - Usage Guide

## Overview

The `use-sync` hook has been refactored to use TanStack Query mutations for better state management, automatic caching, optimistic updates, and React integration.

## Key Features

### 1. **TanStack Query Integration**

- Uses `useMutation` for sync operations
- Automatic loading states and error handling
- Built-in retry logic (manual via `withRetry`)
- Query invalidation after successful sync

### 2. **Optimistic Updates**

- Immediate UI updates for better UX
- Automatic rollback on error
- Smart cache merging for conversations and messages

### 3. **Enhanced State Management**

- Centralized query keys in `src/lib/query-keys.ts`
- Automatic dirty state tracking
- Real-time sync statistics

## Usage Examples

### Basic Sync Operation

```tsx
import { useSync, useSyncStats } from "~/hooks/use-sync";

function SyncButton() {
  const syncMutation = useSync();
  const { data: syncStats } = useSyncStats();

  return (
    <div>
      <button
        onClick={() => syncMutation.mutate()}
        disabled={syncMutation.isPending}
      >
        {syncMutation.isPending ? "Syncing..." : "Sync Now"}
      </button>

      {syncStats?.pendingChanges.total > 0 && (
        <span>Pending: {syncStats.pendingChanges.total} changes</span>
      )}

      {syncMutation.isError && <div>Error: {syncMutation.error?.message}</div>}
    </div>
  );
}
```

### Creating Data with Optimistic Updates

```tsx
import {
  useConversationMutation,
  useMessageMutation,
} from "~/hooks/use-data-mutations";

function ConversationForm() {
  const conversationMutation = useConversationMutation();
  const messageMutation = useMessageMutation();

  const createConversation = async () => {
    try {
      const conversation = await conversationMutation.mutateAsync({
        data: { title: "New Conversation" },
      });

      // Automatically marked as dirty, will sync on next sync operation
      console.log("Created with optimistic update:", conversation);
    } catch (error) {
      console.error("Failed to create conversation:", error);
    }
  };

  const addMessage = async (conversationId: string) => {
    await messageMutation.mutateAsync({
      conversationId,
      data: {
        role: "user",
        parts: [{ type: "text", text: "Hello!" }],
      },
    });
  };

  return (
    <div>
      <button onClick={createConversation}>Create Conversation</button>
    </div>
  );
}
```

### Advanced Sync with Options

```tsx
import { useSync } from "~/hooks/use-sync";

function AdvancedSync() {
  const syncMutation = useSync();

  const handleFullSync = () => {
    // Force sync all records, not just dirty ones
    syncMutation.mutate({ forceFullSync: true });
  };

  const handleAsyncSync = async () => {
    try {
      const result = await syncMutation.mutateAsync();
      console.log("Sync completed:", result);

      // Navigate or show success message
    } catch (error) {
      console.error("Sync failed:", error);
    }
  };

  return (
    <div>
      <button onClick={handleFullSync}>Full Sync</button>
      <button onClick={handleAsyncSync}>Async Sync</button>

      {/* Show detailed sync state */}
      <div>
        Status: {syncMutation.status}
        {syncMutation.isPending && <div>Syncing...</div>}
        {syncMutation.isSuccess && <div>✓ Synced successfully</div>}
        {syncMutation.isError && (
          <div>✗ Error: {syncMutation.error?.message}</div>
        )}
      </div>
    </div>
  );
}
```

### Real-time Sync Status

```tsx
import { useSyncStats, useDirtyRecordsCount } from "~/hooks/use-sync";

function SyncStatus() {
  const { data: syncStats, isLoading } = useSyncStats();
  const { data: dirtyCount } = useDirtyRecordsCount();

  if (isLoading) return <div>Loading sync status...</div>;

  return (
    <div className="sync-status">
      <div>
        Pending Changes: {dirtyCount?.total || 0}(
        {dirtyCount?.conversations || 0} conversations,{" "}
        {dirtyCount?.messages || 0} messages)
      </div>

      {syncStats?.needsInitialSync && (
        <div className="warning">Initial sync required for some records</div>
      )}
    </div>
  );
}
```

## Migration from Old Hook

### Before (Manual State Management)

```tsx
const { sync, syncState, syncError, isLoading } = useSync();

// Manual error handling
if (syncError) {
  console.error(syncError.message);
}
```

### After (TanStack Query)

```tsx
const syncMutation = useSync();

// Automatic error handling via TanStack Query
if (syncMutation.isError) {
  console.error(syncMutation.error?.message);
}

// Access TanStack Query features
console.log("Last sync data:", syncMutation.data);
console.log("Variables from last call:", syncMutation.variables);
```

## Benefits

1. **Better UX**: Optimistic updates make the app feel instant
2. **Automatic Caching**: TanStack Query handles all caching logic
3. **Error Recovery**: Built-in retry and rollback mechanisms
4. **React Integration**: Works seamlessly with React's rendering cycle
5. **Debugging**: Access to detailed mutation state and history
6. **Performance**: Smart query invalidation reduces unnecessary re-renders

## Query Keys Structure

All query keys are centralized in `src/lib/query-keys.ts`:

```typescript
const queryKeys = {
  conversations: {
    all: ["conversations"],
    list: () => ["conversations", "list"],
    detail: (id: string) => ["conversations", "detail", id],
  },
  messages: {
    all: ["messages"],
    byConversation: (id: string) => ["messages", "conversation", id],
  },
  sync: {
    all: ["sync"],
    status: () => ["sync", "status"],
    stats: () => ["sync", "stats"],
  },
};
```

This ensures consistent cache management and prevents cache key conflicts.
