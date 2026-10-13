/**
 * Grant storage in the org's ControlPlane SQLite (ADR 0021): the `grants` table and a one-row `grant_state` (the change
 * counter and the seeded flag).
 *
 * The first time a ControlPlane constructs this store it writes the default grant ("everyone, every shared credential,
 * every model") and sets `seeded`. That is both the new-org path and the upgrade path: an org that existed before
 * grants has no `grant_state` row, gets the default grant once, and so keeps what its members could always do. An org
 * admin who deletes the default grant is not given it back: `seeded` stays set.
 *
 * Every write names the revision it is based on (0 to create), like price overrides; a stale revision is a `conflict`.
 */
import { freshEntryId } from "../credentials/key-ids.ts";
import type { WriteRefused, WriteResult } from "../config/store.ts";
import {
  DEFAULT_GRANT,
  type GrantChange,
  type GrantEntry,
  type GrantScope,
  type GrantSubject,
  type GrantValue,
  type GrantsWire,
  normalizeModelPatterns,
} from "./grant.ts";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS grants (
     id TEXT PRIMARY KEY, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, scope_kind TEXT NOT NULL,
     scope_id TEXT NOT NULL, models TEXT NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL,
     updated_by TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS grant_state (
     id INTEGER PRIMARY KEY CHECK (id = 1), counter INTEGER NOT NULL, seeded INTEGER NOT NULL
   )`,
];

/** Who the default grant is attributed to. */
export const SEED_ACTOR = "system";

interface GrantRow {
  [column: string]: SqlStorageValue;
  id: string;
  subject_kind: string;
  subject_id: string;
  scope_kind: string;
  scope_id: string;
  models: string;
  revision: number;
  updated_at: number;
  updated_by: string;
}

const COLUMNS =
  "id, subject_kind, subject_id, scope_kind, scope_id, models, revision, updated_at, updated_by";

/** Thrown inside a write's transaction to roll it back. */
class Refusal extends Error {
  readonly refused: WriteRefused;

  constructor(refused: WriteRefused) {
    super(refused.message);
    this.refused = refused;
  }
}

const refuse = (error: WriteRefused["error"], message: string): WriteRefused => ({
  ok: false,
  error,
  message,
});

const subjectOf = (row: GrantRow): GrantSubject => {
  switch (row.subject_kind) {
    case "member":
      return { kind: "member", id: row.subject_id };
    case "team":
      return { kind: "team", id: row.subject_id };
    default:
      return { kind: "everyone" };
  }
};

const scopeOf = (row: GrantRow): GrantScope => {
  switch (row.scope_kind) {
    case "provider":
      return { kind: "provider", provider: row.scope_id };
    case "credential":
      return { kind: "credential", id: row.scope_id };
    default:
      return { kind: "all" };
  }
};

const subjectColumns = (subject: GrantSubject): readonly [string, string] =>
  subject.kind === "everyone" ? ["everyone", ""] : [subject.kind, subject.id];

const scopeColumns = (scope: GrantScope): readonly [string, string] => {
  switch (scope.kind) {
    case "all":
      return ["all", ""];
    case "provider":
      return ["provider", scope.provider];
    case "credential":
      return ["credential", scope.id];
  }
};

const trimmedScope = (scope: GrantScope): GrantScope => {
  switch (scope.kind) {
    case "all":
      return scope;
    case "provider":
      return { kind: "provider", provider: scope.provider.trim().toLowerCase() };
    case "credential":
      return { kind: "credential", id: scope.id.trim() };
  }
};

/** `value` with its names trimmed and its patterns normalised, or why it is refused. */
const clean = (value: GrantValue): { readonly value: GrantValue } | WriteRefused => {
  const models = normalizeModelPatterns(value.models);

  if (models.length === 0) return refuse("invalid", "a grant names at least one model pattern");

  const subject: GrantSubject =
    value.subject.kind === "everyone"
      ? value.subject
      : { kind: value.subject.kind, id: value.subject.id.trim() };

  if (subject.kind !== "everyone" && subject.id === "")
    return refuse("invalid", `a grant for a ${subject.kind} names the ${subject.kind}`);

  const scope = trimmedScope(value.scope);

  if (scope.kind === "provider" && scope.provider === "")
    return refuse("invalid", "a grant for a provider names the provider");

  if (scope.kind === "credential" && scope.id === "")
    return refuse("invalid", "a grant for a credential names the credential");

  return { value: { subject, scope, models } };
};

export class GrantStore {
  readonly #sql: SqlStorage;
  readonly #transaction: <T>(body: () => T) => T;
  readonly #now: () => number;
  #cached: { readonly version: number; readonly entries: ReadonlyArray<GrantEntry> } | undefined;

  /** `transaction` runs a body in one storage transaction (`ctx.storage.transactionSync`). */
  constructor(sql: SqlStorage, transaction: <T>(body: () => T) => T, now: () => number = Date.now) {
    this.#sql = sql;
    this.#transaction = transaction;
    this.#now = now;

    for (const statement of SCHEMA) sql.exec(statement);
    this.#seed();
  }

  /** Writes the default grant the first time only (a new org, or an org that existed before grants). */
  #seed(): void {
    this.#transaction(() => {
      if (this.#sql.exec(`SELECT id FROM grant_state WHERE id = 1`).toArray().length > 0) return;

      this.#sql.exec(`INSERT INTO grant_state (id, counter, seeded) VALUES (1, 1, 1)`);
      this.#insert(freshEntryId("grant"), DEFAULT_GRANT, 1, SEED_ACTOR);
    });
  }

  // --- reads ------------------------------------------------------------------------------------------------------

  /** The counter that moves with every grant write and every change of a team's members. */
  version(): number {
    return (
      this.#sql
        .exec<{ counter: number }>(`SELECT counter FROM grant_state WHERE id = 1`)
        .toArray()[0]?.counter ?? 0
    );
  }

  /** Every grant, by subject and scope; read again only when the counter moved (every pick asks). */
  entries(): ReadonlyArray<GrantEntry> {
    const version = this.version();

    if (this.#cached?.version === version) return this.#cached.entries;
    const entries = this.#read();

    this.#cached = { version, entries };

    return entries;
  }

  #read(): ReadonlyArray<GrantEntry> {
    return this.#sql
      .exec<GrantRow>(
        `SELECT ${COLUMNS} FROM grants ORDER BY subject_kind, subject_id, scope_kind, scope_id, id`,
      )
      .toArray()
      .map((row) => ({
        id: row.id,
        subject: subjectOf(row),
        scope: scopeOf(row),
        // SAFETY: `models` holds the JSON array of strings this store wrote.
        models: JSON.parse(row.models) as ReadonlyArray<string>,
        revision: row.revision,
        updated_at: row.updated_at,
        updated_by: row.updated_by,
      }));
  }

  wire(): GrantsWire {
    return { version: this.version(), grants: this.entries() };
  }

  // --- writes -----------------------------------------------------------------------------------------------------

  /**
   * Creates, replaces or deletes (`value: null`) one grant. It names the revision it is based on (0 to create); a second
   * grant for a subject and scope that already has one is a `conflict` (edit that one). `refers` names what a subject
   * or scope points at that does not exist, if anything: the store knows no members, teams or credentials.
   */
  write(
    change: GrantChange,
    by: string,
    refers: (subject: GrantSubject) => string | undefined,
  ): WriteResult<{ readonly id: string; readonly revision: number }> {
    const cleaned = change.value === null ? undefined : clean(change.value);

    if (cleaned !== undefined && "ok" in cleaned) return cleaned;

    if (cleaned !== undefined) {
      const missing = refers(cleaned.value.subject);

      if (missing !== undefined) return refuse("invalid", missing);
    }

    try {
      return this.#transaction(() => {
        const existing =
          change.id === undefined
            ? undefined
            : this.#sql
                .exec<GrantRow>(`SELECT ${COLUMNS} FROM grants WHERE id = ?`, change.id)
                .toArray()[0];

        if (change.id !== undefined && existing === undefined)
          throw new Refusal(
            change.revision === 0
              ? refuse("not_found", "grant not found")
              : refuse("conflict", "the grant was deleted"),
          );

        if (existing === undefined && change.revision !== 0)
          throw new Refusal(refuse("conflict", "a new grant is written at revision 0"));

        if (existing !== undefined && existing.revision !== change.revision)
          throw new Refusal(
            refuse("conflict", `grant is at revision ${existing.revision}, not ${change.revision}`),
          );

        if (cleaned === undefined) {
          if (existing === undefined)
            throw new Refusal(refuse("invalid", "there is no grant to delete"));
          const revision = this.#bump();
          this.#sql.exec(`DELETE FROM grants WHERE id = ?`, existing.id);

          return { ok: true as const, version: revision, id: existing.id, revision: 0 };
        }

        const [subjectKind, subjectId] = subjectColumns(cleaned.value.subject);
        const [scopeKind, scopeId] = scopeColumns(cleaned.value.scope);

        const taken = this.#sql
          .exec<{ id: string }>(
            `SELECT id FROM grants
             WHERE subject_kind = ? AND subject_id = ? AND scope_kind = ? AND scope_id = ? AND id IS NOT ?`,
            subjectKind,
            subjectId,
            scopeKind,
            scopeId,
            existing?.id ?? null,
          )
          .toArray()[0];

        if (taken !== undefined)
          throw new Refusal(
            refuse("conflict", `a grant for that subject and scope exists: ${taken.id}`),
          );

        const revision = this.#bump();
        const id = existing?.id ?? freshEntryId("grant");

        if (existing === undefined) this.#insert(id, cleaned.value, revision, by);
        else
          this.#sql.exec(
            `UPDATE grants SET subject_kind = ?, subject_id = ?, scope_kind = ?, scope_id = ?, models = ?,
               revision = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
            subjectKind,
            subjectId,
            scopeKind,
            scopeId,
            JSON.stringify(cleaned.value.models),
            revision,
            this.#now(),
            by,
            id,
          );

        return { ok: true as const, version: revision, id, revision };
      });
    } catch (error) {
      if (error instanceof Refusal) return error.refused;
      throw error;
    }
  }

  /**
   * A member or team left the org: grants that named it go with it (a member who joins again is a new member, and a
   * team id is never reused). Also moves the counter, since who is in a team decides who a team grant reaches.
   */
  forget(subject: { readonly kind: "member" | "team"; readonly id: string }): void {
    this.#transaction(() => {
      this.#sql.exec(
        `DELETE FROM grants WHERE subject_kind = ? AND subject_id = ?`,
        subject.kind,
        subject.id,
      );
      this.#bump();
    });
  }

  /** The members of a team changed: the counter moves so views built from it are built again. */
  membershipChanged(): void {
    this.#bump();
  }

  // --- internals --------------------------------------------------------------------------------------------------

  #bump(): number {
    const next = this.version() + 1;

    this.#sql.exec(`UPDATE grant_state SET counter = ? WHERE id = 1`, next);

    return next;
  }

  #insert(id: string, value: GrantValue, revision: number, by: string): void {
    const [subjectKind, subjectId] = subjectColumns(value.subject);
    const [scopeKind, scopeId] = scopeColumns(value.scope);

    this.#sql.exec(
      `INSERT INTO grants (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      subjectKind,
      subjectId,
      scopeKind,
      scopeId,
      JSON.stringify(value.models),
      revision,
      this.#now(),
      by,
    );
  }
}
