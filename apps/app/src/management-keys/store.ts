/**
 * An org's management keys inside its ControlPlane Durable Object (SQLite; ADR 0026). New in the Workers port, no Go
 * counterpart.
 *
 * One row per key: its id, a name, the role it holds in the org, the SHA-256 of the whole key (never the key itself),
 * the visible prefix, who issued it (`created_by`: an email or `service:<client id>`), the email of the person it
 * belongs to (the issuer, when a person issued it: their suspension on Commissary Cloud refuses it), and when it was
 * created and last used. Revoking a key deletes its row: it is refused from then on and no longer listed.
 *
 * All methods are synchronous; refusals are plain data. Times are the caller's clock (epoch milliseconds).
 */
import type { OrgRole } from "../members/roles.ts";
import type { OrgId } from "@commissary/core";
import { cleanName, MAX_NAME_LENGTH } from "../platform/registry-store.ts";
import { isKeyId } from "../api-keys/key.ts";
import { LAST_USED_RESOLUTION_MS } from "../api-keys/store.ts";
import { mintManagementKey } from "./key.ts";

export interface ManagementKeyRecord {
  readonly id: string;
  readonly name: string;
  readonly role: OrgRole;
  /** `cmsm_<orgId>_<keyId>_<first 4 secret characters>`. */
  readonly prefix: string;
  readonly createdBy: string;
  readonly ownerEmail?: string;
  /** Epoch milliseconds. */
  readonly createdAt: number;
  readonly lastUsedAt?: number;
}

export type ManagementKeyErrorCode = "invalid_name" | "too_many_keys" | "management_key_not_found";

export type ManagementKeyResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: ManagementKeyErrorCode; readonly message: string };

/** The ControlPlane's answer to a presented key; the client sees the same `Invalid API key` for every refusal. */
export type ManagementKeyVerdict =
  | {
      readonly ok: true;
      readonly name: string;
      readonly role: OrgRole;
      readonly ownerEmail?: string;
    }
  | { readonly ok: false };

/** At most this many keys per org, so an org cannot fill its storage. */
export const MAX_MANAGEMENT_KEYS = 100;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS management_keys (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, hash TEXT NOT NULL, prefix TEXT NOT NULL,
     created_by TEXT NOT NULL, owner_email TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER
   )`,
];

interface KeyRow {
  id: string;
  name: string;
  role: string;
  hash: string;
  prefix: string;
  created_by: string;
  owner_email: string | null;
  created_at: number;
  last_used_at: number | null;
  [column: string]: SqlStorageValue;
}

interface CountRow {
  n: number;
  [column: string]: SqlStorageValue;
}

const COLUMNS = `id, name, role, hash, prefix, created_by, owner_email, created_at, last_used_at`;

const HASH = /^[0-9a-f]{64}$/;

const ROLES: ReadonlyArray<OrgRole> = ["owner", "admin", "member"];

const roleOf = (text: string): OrgRole => ROLES.find((role) => role === text) ?? "member";

const encoder = new TextEncoder();

/** Compares two hashes in time that does not depend on where they differ. */
const sameHash = (stored: string, presented: string): boolean => {
  if (!HASH.test(presented) || stored.length !== presented.length) return false;

  return crypto.subtle.timingSafeEqual(encoder.encode(stored), encoder.encode(presented));
};

const record = (row: KeyRow): ManagementKeyRecord => {
  const base: ManagementKeyRecord = {
    id: row.id,
    name: row.name,
    role: roleOf(row.role),
    prefix: row.prefix,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };

  const withOwner = row.owner_email === null ? base : { ...base, ownerEmail: row.owner_email };

  return row.last_used_at === null ? withOwner : { ...withOwner, lastUsedAt: row.last_used_at };
};

const NOT_FOUND = {
  ok: false,
  error: "management_key_not_found",
  message: "no management key has this id",
} as const;

export class ManagementKeyStore {
  readonly #sql: SqlStorage;
  readonly #org: OrgId;

  constructor(sql: SqlStorage, org: OrgId) {
    this.#sql = sql;
    this.#org = org;

    for (const statement of SCHEMA) sql.exec(statement);
  }

  /** The org's keys, newest first. */
  list(): ReadonlyArray<ManagementKeyRecord> {
    return this.#sql
      .exec<KeyRow>(`SELECT ${COLUMNS} FROM management_keys ORDER BY created_at DESC, id`)
      .toArray()
      .map(record);
  }

  /** Issues a key (the caller checked who may issue which role). Answers the whole key, which is not stored. */
  create(
    input: {
      readonly name: string;
      readonly role: OrgRole;
      readonly createdBy: string;
      readonly ownerEmail?: string;
    },
    now: number,
  ): ManagementKeyResult<{ readonly record: ManagementKeyRecord; readonly key: string }> {
    const name = cleanName(input.name);

    if (name === undefined)
      return {
        ok: false,
        error: "invalid_name",
        message: `a name is 1 to ${MAX_NAME_LENGTH} characters without control characters`,
      };

    if (
      (this.#sql.exec<CountRow>(`SELECT COUNT(*) AS n FROM management_keys`).toArray()[0]?.n ??
        0) >= MAX_MANAGEMENT_KEYS
    )
      return {
        ok: false,
        error: "too_many_keys",
        message: `an org holds at most ${MAX_MANAGEMENT_KEYS} management keys`,
      };

    let minted = mintManagementKey(this.#org);

    while (this.#row(minted.keyId) !== undefined) minted = mintManagementKey(this.#org);

    this.#sql.exec(
      `INSERT INTO management_keys (id, name, role, hash, prefix, created_by, owner_email, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      minted.keyId,
      name,
      input.role,
      minted.hash,
      minted.prefix,
      input.createdBy,
      input.ownerEmail?.toLowerCase() ?? null,
      now,
    );

    const row = this.#row(minted.keyId);

    if (row === undefined) throw new Error("the management key just written is missing");

    return { ok: true, value: { record: record(row), key: minted.key } };
  }

  /** Revokes a key: deletes it, so the next request with it is refused. */
  revoke(id: string): ManagementKeyResult<ManagementKeyRecord> {
    const row = this.#row(id);

    if (row === undefined) return NOT_FOUND;
    this.#sql.exec(`DELETE FROM management_keys WHERE id = ?`, id);

    return { ok: true, value: record(row) };
  }

  /**
   * Checks a presented key: its id must be stored with the same hash (compared in constant time). Records when it was
   * last used, at most once per {@link LAST_USED_RESOLUTION_MS}.
   */
  check(keyId: string, hash: string, now: number): ManagementKeyVerdict {
    const row = isKeyId(keyId) ? this.#row(keyId) : undefined;

    if (row === undefined || !sameHash(row.hash, hash)) return { ok: false };

    if (row.last_used_at === null || now - row.last_used_at >= LAST_USED_RESOLUTION_MS)
      this.#sql.exec(`UPDATE management_keys SET last_used_at = ? WHERE id = ?`, now, keyId);
    const verdict = { ok: true as const, name: row.name, role: roleOf(row.role) };

    return row.owner_email === null ? verdict : { ...verdict, ownerEmail: row.owner_email };
  }

  #row(id: string): KeyRow | undefined {
    return this.#sql
      .exec<KeyRow>(`SELECT ${COLUMNS} FROM management_keys WHERE id = ?`, id)
      .toArray()[0];
  }
}
