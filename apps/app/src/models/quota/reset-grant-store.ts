/**
 * SQLite persistence of the Claude reset grants inside the ControlPlane Durable Object, beside the quota reports
 * (`store.ts`, same pattern): one row per credential id with the last status read (`status`), the open claim journal
 * (`claim`, `reset-grants.ts` `ClaimJournal`) and two counters that are never reset:
 *
 * - `generation` grows when the credential's grants stop applying (`forget`: a re-login replacing the tokens, or the
 *   credential being removed, so a credential re-created under the same name starts a new generation);
 * - `claim_seq` grows at every claim start and answer of the row's credential; a mark carries their sum over every
 *   row, so a claim of any account (another auth file of the same organization included) makes a status read begun
 *   before it stale, even once that claim's journal is gone. Rows are never deleted, so the sum only grows.
 *
 * Together they form the `ResetGrantMark` handed out with the token before an upstream status read: a status is
 * stored, and a fresh claim started from it, only while the mark is unchanged, so a read that began before a re-login
 * or before another claim spent a reset can neither overwrite newer state nor start a second claim. The counters are
 * compared inside this object only (no clocks of different machines are compared). A row whose status and claim are
 * gone keeps its counters (a few bytes per credential id ever seen).
 *
 * The journal is kept here rather than in memory so an unanswered claim survives an eviction of the object: its
 * request id is what keeps a resend from spending a second reset. A journal in flight outlives `forget` (its answer
 * is still recorded, and it keeps holding its organization). Columns that no longer decode read as absent.
 *
 * All methods are synchronous so read-modify-write sequences are atomic under the Durable Object input gate.
 */
import { Option, Schema } from "effect";
import { type Json, tryParseJson } from "@commissary/json";
import { ResetGrantStatus } from "@commissary/contract/credentials";
import { ClaimJournal } from "./reset-grants.ts";

/** The grant state version a status read or claim was based on (see the module header). */
export interface ResetGrantMark {
  readonly generation: number;
  readonly claimSeq: number;
}

/** What `putStatus` did with a status. */
export type PutStatusResult = "stored" | "older" | "stale" | "replaced";

interface GrantRow {
  id: string;
  status: string | null;
  claim: string | null;
  generation: number;
  claim_seq: number;
  [column: string]: SqlStorageValue;
}

const decodeStatus = Schema.decodeUnknownOption(ResetGrantStatus);

const decodeClaim = Schema.decodeUnknownOption(ClaimJournal);

const decoded = <A>(
  raw: string | null,
  decode: (stored: Json) => Option.Option<A>,
): A | undefined => {
  const parsed = raw === null ? undefined : tryParseJson(raw);

  return parsed === undefined ? undefined : Option.getOrUndefined(decode(parsed));
};

const json = (claim: ClaimJournal | undefined): string | null =>
  claim === undefined ? null : JSON.stringify(claim);

const COLUMNS = "id, status, claim, generation, claim_seq";

export class ResetGrantStore {
  readonly #sql: SqlStorage;
  readonly #now: () => number;

  constructor(sql: SqlStorage, now: () => number = Date.now) {
    this.#sql = sql;
    this.#now = now;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS credential_reset_grants (
         id TEXT PRIMARY KEY,
         status TEXT,
         claim TEXT,
         generation INTEGER NOT NULL DEFAULT 0,
         claim_seq INTEGER NOT NULL DEFAULT 0,
         updated_at INTEGER NOT NULL
       )`,
    );
  }

  #row(id: string): GrantRow | undefined {
    return this.#sql
      .exec<GrantRow>(`SELECT ${COLUMNS} FROM credential_reset_grants WHERE id = ?`, id)
      .toArray()[0];
  }

  #write(
    id: string,
    columns: {
      readonly status: string | null;
      readonly claim: string | null;
      readonly generation: number;
      readonly claimSeq: number;
    },
  ): void {
    this.#sql.exec(
      `INSERT INTO credential_reset_grants (id, status, claim, generation, claim_seq, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET status = excluded.status, claim = excluded.claim,
         generation = excluded.generation, claim_seq = excluded.claim_seq, updated_at = excluded.updated_at`,
      id,
      columns.status,
      columns.claim,
      columns.generation,
      columns.claimSeq,
      this.#now(),
    );
  }

  #current(id: string) {
    const row = this.#row(id);

    return {
      status: row?.status ?? null,
      claim: row?.claim ?? null,
      generation: row?.generation ?? 0,
      claimSeq: row?.claim_seq ?? 0,
    };
  }

  /** Claim activity across every credential (see the module header). */
  #claimSeq(): number {
    const [row] = this.#sql
      .exec<{ total: number | null }>("SELECT SUM(claim_seq) AS total FROM credential_reset_grants")
      .toArray();

    return row?.total ?? 0;
  }

  /** The current mark of `id` (generation zero for a credential never seen). */
  mark(id: string): ResetGrantMark {
    return { generation: this.#current(id).generation, claimSeq: this.#claimSeq() };
  }

  status(id: string): ResetGrantStatus | undefined {
    return decoded(this.#row(id)?.status ?? null, decodeStatus);
  }

  /** Every stored status by credential id. */
  statuses(): Map<string, ResetGrantStatus> {
    const statuses = new Map<string, ResetGrantStatus>();

    for (const row of this.#sql
      .exec<GrantRow>(`SELECT ${COLUMNS} FROM credential_reset_grants WHERE status IS NOT NULL`)
      .toArray()) {
      const status = decoded(row.status, decodeStatus);

      if (status !== undefined) statuses.set(row.id, status);
    }

    return statuses;
  }

  claim(id: string): ClaimJournal | undefined {
    return decoded(this.#row(id)?.claim ?? null, decodeClaim);
  }

  /**
   * Stores a status read under `mark`. Not stored: `replaced` when the credential was replaced or removed since,
   * `stale` when a claim started or was answered since (the read may predate a spent reset), `older` when the stored
   * status was read later.
   */
  putStatus(id: string, status: ResetGrantStatus, mark: ResetGrantMark): PutStatusResult {
    const current = this.#current(id);

    if (current.generation !== mark.generation) return "replaced";

    if (this.#claimSeq() !== mark.claimSeq) return "stale";
    const stored = decoded(current.status, decodeStatus);

    if (stored !== undefined && Date.parse(stored.checked_at) > Date.parse(status.checked_at))
      return "older";
    this.#write(id, { ...current, status: JSON.stringify(status) });

    return "stored";
  }

  /** Replaces the claim journal; every claim start and answer advances `claim_seq`. */
  putClaim(id: string, claim: ClaimJournal | undefined): void {
    const current = this.#current(id);

    this.#write(id, { ...current, claim: json(claim), claimSeq: current.claimSeq + 1 });
  }

  /** Every stored claim journal by credential id (the open ones, and those in flight). */
  claims(): Map<string, ClaimJournal> {
    const claims = new Map<string, ClaimJournal>();

    for (const row of this.#sql
      .exec<GrantRow>(`SELECT ${COLUMNS} FROM credential_reset_grants WHERE claim IS NOT NULL`)
      .toArray()) {
      const claim = decoded(row.claim, decodeClaim);

      if (claim !== undefined) claims.set(row.id, claim);
    }

    return claims;
  }

  /**
   * Drops the status and starts a new generation (re-login, removal). The claim journal is dropped too unless a request
   * of it is in flight: its answer must still be recorded, and until then it holds its organization (`beginClaim`).
   */
  forget(id: string): void {
    const current = this.#current(id);
    const claim = decoded(current.claim, decodeClaim);
    const keep = claim !== undefined && claim.in_flight_until > this.#now();

    this.#write(id, {
      ...current,
      status: null,
      claim: keep ? current.claim : null,
      generation: current.generation + 1,
    });
  }
}
