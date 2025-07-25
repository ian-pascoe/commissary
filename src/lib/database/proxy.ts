import type Database from "@tauri-apps/plugin-sql";
import type {
  AsyncBatchRemoteCallback,
  RemoteCallback,
} from "drizzle-orm/sqlite-proxy";

export function createProxy(sqlite: Database): RemoteCallback {
  return async (sql, params, method) => {
    let rows: any = [];
    let results = [];

    // If the query is a SELECT, use the select method
    if (isSelectQuery(sql) || hasReturning(sql)) {
      rows = await sqlite.select(sql, params);
    } else {
      // Otherwise, use the execute method
      await sqlite.execute(sql, params);
      return { rows: [] };
    }

    rows = rows.map((row: any) => {
      return Object.values(row);
    });

    // If the method is "all", return all rows
    results = method === "all" ? rows : rows[0];

    return { rows: results };
  };
}

export function createBatchProxy(sqlite: Database): AsyncBatchRemoteCallback {
  return async (queries) => {
    return await Promise.allSettled(
      queries.map(async ({ sql, params, method }) => {
        const proxy = createProxy(sqlite);
        return await proxy(sql, params, method);
      }),
    ).then((results) =>
      results.map((result) => {
        if (result.status === "fulfilled") {
          return result.value;
        } else {
          throw new Error(
            `Batch query failed: ${result.reason.message || result.reason}`,
          );
        }
      }),
    );
  };
}

/**
 * Checks if the given SQL query is a SELECT query.
 * @param sql The SQL query to check.
 * @returns True if the query is a SELECT query, false otherwise.
 */
function isSelectQuery(sql: string): boolean {
  const selectRegex = /^\s*SELECT\b/i;
  return selectRegex.test(sql);
}

function hasReturning(sql: string): boolean {
  const returningRegex = /\bRETURNING\b/i;
  return returningRegex.test(sql);
}
