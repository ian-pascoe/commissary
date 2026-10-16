/**
 * The `SessionState` instances an org owns, kept in the org's ControlPlane (ADR 0027).
 *
 * A Durable Object namespace cannot be listed, so deleting an org needs another way to find the `SessionState` instances
 * that hold its replay and continuity state. Each instance of an org (not `global`) registers its name here when it
 * starts holding entries, and again when its entries could outlive the registration; deleting the org wipes the
 * registered instances. A registration expires after the longest an instance can keep an entry ({@link MAX_TTL_MS}):
 * past it the instance has deleted itself, so nothing is left to find. Workers addition, no Go counterpart.
 */
export interface SessionInstanceRow {
  name: string;
  [column: string]: SqlStorageValue;
}

export class SessionInstanceStore {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS session_instances (name TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)`,
    );
  }

  /** Records that instance `name` may hold entries until `expiresAt`; forgets the registrations that ended by `now`. */
  register(name: string, now: number, expiresAt: number): void {
    this.#sql.exec(`DELETE FROM session_instances WHERE expires_at <= ?`, now);
    this.#sql.exec(
      `INSERT INTO session_instances (name, expires_at) VALUES (?, ?)
       ON CONFLICT (name) DO UPDATE SET expires_at = MAX(expires_at, excluded.expires_at)`,
      name,
      expiresAt,
    );
  }

  /** Up to `limit` registered instances that may still hold entries at `now`. */
  list(now: number, limit: number): ReadonlyArray<string> {
    return this.#sql
      .exec<SessionInstanceRow>(
        `SELECT name FROM session_instances WHERE expires_at > ? ORDER BY name LIMIT ?`,
        now,
        limit,
      )
      .toArray()
      .map((row) => row.name);
  }

  forget(names: ReadonlyArray<string>): void {
    for (const name of names) this.#sql.exec(`DELETE FROM session_instances WHERE name = ?`, name);
  }
}
