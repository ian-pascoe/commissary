import { count, eq, isNull } from "drizzle-orm";
import {
  conversations as conversationsTable,
  messages as messagesTable,
} from "~~/drizzle/local/schema";
import type { LocalDatabase } from "../lib/database";

/**
 * Utility functions for managing sync state and dirty flags
 */

export const markConversationDirty = async (db: LocalDatabase, id: string) => {
  await db
    .update(conversationsTable)
    .set({ isDirty: true, updatedAt: new Date() })
    .where(eq(conversationsTable.id, id));
};

export const markMessageDirty = async (db: LocalDatabase, id: string) => {
  await db
    .update(messagesTable)
    .set({ isDirty: true, updatedAt: new Date() })
    .where(eq(messagesTable.id, id));
};

export const markConversationDeleted = async (
  db: LocalDatabase,
  id: string,
) => {
  await db
    .update(conversationsTable)
    .set({ isDeleted: true, isDirty: true, updatedAt: new Date() })
    .where(eq(conversationsTable.id, id));
};

export const markMessageDeleted = async (db: LocalDatabase, id: string) => {
  await db
    .update(messagesTable)
    .set({ isDeleted: true, isDirty: true, updatedAt: new Date() })
    .where(eq(messagesTable.id, id));
};

export const getDirtyRecordsCount = async (db: LocalDatabase) => {
  const [conversationsCount, messagesCount] = await db.batch([
    db
      .select({ count: count() })
      .from(conversationsTable)
      .where(eq(conversationsTable.isDirty, true)),
    db
      .select({ count: count() })
      .from(messagesTable)
      .where(eq(messagesTable.isDirty, true)),
  ]);

  return {
    conversations: conversationsCount[0]?.count || 0,
    messages: messagesCount[0]?.count || 0,
    total: (conversationsCount[0]?.count || 0) + (messagesCount[0]?.count || 0),
  };
};

export const getSyncStats = async (db: LocalDatabase) => {
  const [unsyncedConversations, unsyncedMessages, dirtyCount] =
    await Promise.all([
      db
        .select({ count: count() })
        .from(conversationsTable)
        .where(isNull(conversationsTable.lastSyncedAt)),
      db
        .select({ count: count() })
        .from(messagesTable)
        .where(isNull(messagesTable.lastSyncedAt)),
      getDirtyRecordsCount(db),
    ]);

  return {
    needsInitialSync:
      (unsyncedConversations[0]?.count || 0) > 0 ||
      (unsyncedMessages[0]?.count || 0) > 0,
    pendingChanges: dirtyCount,
  };
};
