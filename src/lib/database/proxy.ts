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
    if (isSelectQuery(sql)) {
      rows = await sqlite.select(sql, params).catch((e) => {
        console.error("SQL Error:", e);
        return [];
      });
    } else {
      // Otherwise, use the execute method
      rows = await sqlite.execute(sql, params).catch((e) => {
        console.error("SQL Error:", e);
        return [];
      });
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
    return await Promise.all(
      queries.map(async ({ sql, params, method }) => {
        const proxy = createProxy(sqlite);
        return await proxy(sql, params, method);
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
