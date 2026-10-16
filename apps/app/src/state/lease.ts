/**
 * Named leases in a Durable Object's SQLite storage, so one piece of work runs at a time across isolates. Workers
 * addition, no Go counterpart.
 *
 * Work that runs in a Worker, possibly in several isolates at once, takes a lease from a Durable Object first: one
 * SQLite row per lease name, read and written synchronously, so taking it is atomic under the object's input gate.
 * Times are the object's own clock, never the caller's. The holder gives the lease back with its token when it ends; a
 * holder that may outlast {@link LEASE_TTL_MS} renews it. A lease not renewed for {@link LEASE_TTL_MS} counts as
 * abandoned (its Worker died), and the next taker takes it over. A second taker that finds the lease held is refused
 * and told who holds it.
 *
 * Leases in use: the ControlPlane's `quota_sweep` (one check of every quota at a time, renewed while it runs:
 * src/quota/check.ts) and the Platform registry's `catalog_refresh` (one model catalog download at a time, not renewed:
 * src/registry/refresh.ts).
 *
 * Each name has its own table, `<name>_lease`, as each lease had before leases were named, so the rows stored then
 * read back. A token names its lease (`<name>:<uuid>`), so renewing and giving it back need only the token; a token
 * stored before that (a bare UUID) still holds its lease until it is abandoned.
 */

/** Who started the work holding the lease: the scheduled task or the panel. */
export type LeaseSource = "cron" | "panel";

export interface Lease {
  readonly token: string;
  readonly source: LeaseSource;
  readonly startedAt: number;
  /** When the holder last showed it is alive (taken or renewed). */
  readonly renewedAt: number;
}

/** A holder renews well within this (a quota sweep: each account's check is bounded by 15 s per upstream call). */
export const LEASE_TTL_MS = 2 * 60_000;

export type TakeLease =
  | { readonly ok: true; readonly lease: Lease }
  | { readonly ok: false; readonly held: Lease };

/** Whether a new holder may take the lease while `current` is stored (pure): only once it is gone or abandoned. */
export const mayTake = (current: Lease | undefined, now: number): boolean =>
  current === undefined || now - current.renewedAt >= LEASE_TTL_MS;

/** A lease name is part of its table's name: lowercase letters, digits and underscores, starting with a letter. */
const LEASE_NAME = /^[a-z][a-z0-9_]*$/;

interface LeaseRow {
  token: string;
  source: string;
  started_at: number;
  renewed_at: number;
  [column: string]: SqlStorageValue;
}

export class LeaseStore {
  readonly #sql: SqlStorage;
  readonly #now: () => number;
  /** The names whose table this object has made sure of since it started. */
  readonly #ready = new Set<string>();

  constructor(sql: SqlStorage, now: () => number = Date.now) {
    this.#sql = sql;
    this.#now = now;
  }

  current(name: string): Lease | undefined {
    const row = this.#sql
      .exec<LeaseRow>(
        `SELECT token, source, started_at, renewed_at FROM ${this.#table(name)} WHERE id = 1`,
      )
      .toArray()[0];

    if (row === undefined) return undefined;

    return {
      token: row.token,
      source: row.source === "cron" ? "cron" : "panel",
      startedAt: row.started_at,
      renewedAt: row.renewed_at,
    };
  }

  /** Takes the lease `name` for work started by `source` now, unless a live holder has it. */
  take(name: string, source: LeaseSource): TakeLease {
    const now = this.#now();
    const current = this.current(name);

    if (current !== undefined && !mayTake(current, now)) return { ok: false, held: current };

    const lease: Lease = {
      token: `${name}:${crypto.randomUUID()}`,
      source,
      startedAt: now,
      renewedAt: now,
    };

    this.#sql.exec(
      `INSERT INTO ${this.#table(name)} (id, token, source, started_at, renewed_at) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET token = excluded.token, source = excluded.source,
         started_at = excluded.started_at, renewed_at = excluded.renewed_at`,
      lease.token,
      lease.source,
      lease.startedAt,
      lease.renewedAt,
    );

    return { ok: true, lease };
  }

  /** Marks the holder of `token` alive now; `false` when the token no longer holds its lease. */
  renew(token: string): boolean {
    const table = this.#tableOf(token);

    return (
      table !== undefined &&
      this.#sql.exec(
        `UPDATE ${table} SET renewed_at = ? WHERE id = 1 AND token = ?`,
        this.#now(),
        token,
      ).rowsWritten > 0
    );
  }

  /** Gives the lease back; a token that no longer holds it (taken over after the TTL) changes nothing. */
  release(token: string): void {
    const table = this.#tableOf(token);

    if (table !== undefined)
      this.#sql.exec(`DELETE FROM ${table} WHERE id = 1 AND token = ?`, token);
  }

  /** The table of the lease `token` was taken for; `undefined` for a token this store never handed out. */
  #tableOf(token: string): string | undefined {
    const name = token.slice(0, Math.max(0, token.indexOf(":")));

    return LEASE_NAME.test(name) ? this.#table(name) : undefined;
  }

  /** The table of the lease `name`, created (or brought up to date) the first time this object uses it. */
  #table(name: string): string {
    if (!LEASE_NAME.test(name)) throw new Error(`invalid lease name: ${JSON.stringify(name)}`);

    const table = `${name}_lease`;

    if (this.#ready.has(name)) return table;

    // A table from before leases were renewed (no `renewed_at`): it holds only a transient lease, so it is recreated.
    const columns = this.#sql
      .exec<{ name: string }>(`PRAGMA table_info(${table})`)
      .toArray()
      .map((column) => column.name);

    if (columns.length > 0 && !columns.includes("renewed_at"))
      this.#sql.exec(`DROP TABLE ${table}`);
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS ${table} (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         token TEXT NOT NULL,
         source TEXT NOT NULL,
         started_at INTEGER NOT NULL,
         renewed_at INTEGER NOT NULL
       )`,
    );
    this.#ready.add(name);

    return table;
  }
}
