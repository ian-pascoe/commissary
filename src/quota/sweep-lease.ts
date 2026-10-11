/**
 * The lease that keeps one check of every quota at a time (the `quota-check` cron task and the panel's "Check all
 * quotas", `POST /credentials/quota/all`). Workers addition, no Go counterpart.
 *
 * The sweep itself runs in a Worker (src/quota/check.ts `sweepQuotas`), possibly in several isolates at once, so the
 * lease lives in the ControlPlane Durable Object: one SQLite row, read and written synchronously, so taking it is
 * atomic under the object's input gate. Times are the object's own clock, never the caller's. A sweep takes the lease
 * before its first provider call, renews it after every account (`renew`, or the token passed with the account's
 * report) and every 30 s besides (one account's token refresh can outlast the lease), stops when a renewal finds it
 * lost, and gives it back with its token when it ends, however it ends (the release step of `acquireUseRelease`, kept
 * alive with `ctx.waitUntil`, which outlives a client disconnect by only ~30 s; the expiry covers the rest). A second sweep that finds the lease held is refused (the panel answers `409 quota_check_running`,
 * the cron task skips its run) instead of asking every provider a second time. A Worker that dies mid-sweep never
 * gives the lease back: a lease not renewed for {@link LEASE_TTL_MS} counts as abandoned and the next sweep takes it
 * over. There is no rate limit beyond that: a sweep started right after another one finished checks again, which is
 * what the operator asked for.
 */
/** Who started the sweep: the scheduled task or the panel. */
export type SweepSource = "cron" | "panel";

export interface SweepLease {
  readonly token: string;
  readonly source: SweepSource;
  readonly startedAt: number;
  /** When the sweep last showed it is alive (taken or renewed). */
  readonly renewedAt: number;
}

/** One account's check is bounded by 15 s per upstream call, so a live sweep renews well within this. */
export const LEASE_TTL_MS = 2 * 60_000;

export type TakeLease =
  | { readonly ok: true; readonly lease: SweepLease }
  | { readonly ok: false; readonly held: SweepLease };

/** Whether a new sweep may start while `current` is stored (pure): only once it is gone or abandoned. */
export const mayTake = (current: SweepLease | undefined, now: number): boolean =>
  current === undefined || now - current.renewedAt >= LEASE_TTL_MS;

interface LeaseRow {
  token: string;
  source: string;
  started_at: number;
  renewed_at: number;
  [column: string]: SqlStorageValue;
}

export class SweepLeaseStore {
  readonly #sql: SqlStorage;
  readonly #now: () => number;

  constructor(sql: SqlStorage, now: () => number = Date.now) {
    this.#sql = sql;
    this.#now = now;

    // A table from before leases were renewed (no `renewed_at`): it holds only a transient lease, so it is recreated.
    const columns = sql
      .exec<{ name: string }>("PRAGMA table_info(quota_sweep_lease)")
      .toArray()
      .map((column) => column.name);

    if (columns.length > 0 && !columns.includes("renewed_at"))
      sql.exec("DROP TABLE quota_sweep_lease");
    sql.exec(
      `CREATE TABLE IF NOT EXISTS quota_sweep_lease (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         token TEXT NOT NULL,
         source TEXT NOT NULL,
         started_at INTEGER NOT NULL,
         renewed_at INTEGER NOT NULL
       )`,
    );
  }

  current(): SweepLease | undefined {
    const row = this.#sql
      .exec<LeaseRow>(
        "SELECT token, source, started_at, renewed_at FROM quota_sweep_lease WHERE id = 1",
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

  /** Takes the lease for a sweep started by `source` now, unless a live sweep holds it. */
  take(source: SweepSource): TakeLease {
    const now = this.#now();
    const current = this.current();

    if (current !== undefined && !mayTake(current, now)) return { ok: false, held: current };

    const lease: SweepLease = {
      token: crypto.randomUUID(),
      source,
      startedAt: now,
      renewedAt: now,
    };

    this.#sql.exec(
      `INSERT INTO quota_sweep_lease (id, token, source, started_at, renewed_at) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET token = excluded.token, source = excluded.source,
         started_at = excluded.started_at, renewed_at = excluded.renewed_at`,
      lease.token,
      lease.source,
      lease.startedAt,
      lease.renewedAt,
    );

    return { ok: true, lease };
  }

  /** Marks the sweep holding `token` alive now; `false` when the token no longer holds the lease. */
  renew(token: string): boolean {
    return (
      this.#sql.exec(
        "UPDATE quota_sweep_lease SET renewed_at = ? WHERE id = 1 AND token = ?",
        this.#now(),
        token,
      ).rowsWritten > 0
    );
  }

  /** Gives the lease back; a token that no longer holds it (taken over after the TTL) changes nothing. */
  release(token: string): void {
    this.#sql.exec("DELETE FROM quota_sweep_lease WHERE id = 1 AND token = ?", token);
  }
}
