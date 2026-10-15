/**
 * An org's API keys inside its ControlPlane Durable Object (SQLite; ADR 0022). New in the Workers port, no Go
 * counterpart.
 *
 * - **proxy_keys**: one row per key: its id, the member it belongs to, a name, the SHA-256 of the whole key (never the
 *   key itself: a hash needs no sealing), the visible prefix, and when it was created, last used and expires. A key
 *   that is revoked or has expired is deleted, not kept marked (zero data retention, ADR 0027): revoking deletes the row
 *   at once, an expired key is deleted by the next listing, issue or presentation of it, and by the cron sweep. The
 *   `revoked_at` column of the first version stays in the table, never written; rows a previous version revoked are
 *   deleted when the ControlPlane starts.
 * - **proxy_key_settings**: one row of org-wide state: whether the org still accepts Access sign-ins (the clients of
 *   the time before API keys) on the proxy routes. On for `global`, where clients signed in through Access before,
 *   off for every other org.
 *
 * All methods are synchronous; refusals are plain data (`ApiKeyRefused`). Times are the caller's clock (epoch
 * milliseconds), so the Worker's `Clock` drives them.
 */
import type { OrgRole } from "../members/roles.ts";
import { GLOBAL_ORG, type OrgId } from "../platform/org.ts";
import { cleanName, MAX_NAME_LENGTH } from "../platform/registry-store.ts";
import { isKeyId, mintApiKey } from "./key.ts";

export interface ApiKeyRecord {
  readonly id: string;
  readonly memberId: string;
  readonly name: string;
  /** `cfp_<orgId>_<keyId>_<first 4 secret characters>`. */
  readonly prefix: string;
  /** Epoch milliseconds. */
  readonly createdAt: number;
  readonly lastUsedAt?: number;
  readonly expiresAt?: number;
  readonly revokedAt?: number;
}

export type ApiKeyErrorCode =
  | "invalid_name"
  | "invalid_expiry"
  | "too_many_keys"
  | "api_key_not_found";

/** A refused write; `message` is fixed text, safe to show. */
export interface ApiKeyRefused {
  readonly ok: false;
  readonly error: ApiKeyErrorCode;
  readonly message: string;
}

export type ApiKeyResult<A> = { readonly ok: true; readonly value: A } | ApiKeyRefused;

/** Why a presented key was refused; the client sees the same `Invalid API key` for each. */
export type ApiKeyRejection = "unknown" | "expired";

export type ApiKeyCheck =
  | { readonly ok: true; readonly memberId: string; readonly expiresAt?: number }
  | { readonly ok: false; readonly reason: ApiKeyRejection };

/** A key as the org's lists show it: with the email of its member, while they are one. */
export interface ApiKeyListing extends ApiKeyRecord {
  readonly memberEmail?: string | undefined;
}

/** A key was asked for a member the org does not have. */
export interface MemberNotFound {
  readonly ok: false;
  readonly error: "member_not_found";
  readonly message: string;
}

/** The ControlPlane's answer to a presented key: its live member and their role, or why it is refused. */
export type ApiKeyVerdict =
  | {
      readonly ok: true;
      readonly memberId: string;
      readonly email: string;
      readonly role: OrgRole;
      /** When the key expires (epoch ms), so a cache of verified keys never keeps it longer. */
      readonly expiresAt?: number;
    }
  | { readonly ok: false; readonly reason: ApiKeyRejection };

/** The org accepts only API keys on its proxy routes: an Access sign-in is not admitted there. */
export interface ClientsUseApiKeys {
  readonly apiKeysOnly: true;
}

/** At most this many keys per member, so a member cannot fill the org's storage. */
export const MAX_KEYS_PER_MEMBER = 100;

/** `last_used_at` is written at most this often per key, so busy clients do not write on every request. */
export const LAST_USED_RESOLUTION_MS = 60_000;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS proxy_keys (
     id TEXT PRIMARY KEY, member_id TEXT NOT NULL, name TEXT NOT NULL, hash TEXT NOT NULL, prefix TEXT NOT NULL,
     created_at INTEGER NOT NULL, last_used_at INTEGER, expires_at INTEGER,
     revoked_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS proxy_keys_by_member ON proxy_keys (member_id)`,
  `CREATE TABLE IF NOT EXISTS proxy_key_settings (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     access_clients INTEGER NOT NULL
   )`,
];

interface KeyRow {
  id: string;
  member_id: string;
  name: string;
  hash: string;
  prefix: string;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
  [column: string]: SqlStorageValue;
}

interface SettingsRow {
  access_clients: number;
  [column: string]: SqlStorageValue;
}

interface CountRow {
  n: number;
  [column: string]: SqlStorageValue;
}

const COLUMNS = `id, member_id, name, hash, prefix, created_at, last_used_at, expires_at, revoked_at`;

const HASH = /^[0-9a-f]{64}$/;

const MESSAGES = {
  invalidName: `a name is 1 to ${MAX_NAME_LENGTH} characters without control characters`,
  invalidExpiry: "a key expires at a time in the future",
  tooManyKeys: `a member holds at most ${MAX_KEYS_PER_MEMBER} API keys`,
  notFound: "no API key has this id",
} as const;

const refuse = (error: ApiKeyErrorCode, message: string): ApiKeyRefused => ({
  ok: false,
  error,
  message,
});

const encoder = new TextEncoder();

/** Compares two hashes in time that does not depend on where they differ. */
const sameHash = (stored: string, presented: string): boolean => {
  if (!HASH.test(presented) || stored.length !== presented.length) return false;

  return crypto.subtle.timingSafeEqual(encoder.encode(stored), encoder.encode(presented));
};

const record = (row: KeyRow): ApiKeyRecord => ({
  id: row.id,
  memberId: row.member_id,
  name: row.name,
  prefix: row.prefix,
  createdAt: row.created_at,
  ...(row.last_used_at === null ? {} : { lastUsedAt: row.last_used_at }),
  ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
  ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
});

export class ApiKeyStore {
  readonly #sql: SqlStorage;
  readonly #org: OrgId;
  readonly #removed: (ids: ReadonlyArray<string>) => void;

  /**
   * `org`: the org the keys name; Access sign-ins stay accepted on the proxy routes of `global` until turned off.
   * `removed` is told the ids of the keys deleted from now on (revoked, expired or their member gone), so what hangs on
   * a key (its Spend limits and counters) is deleted with it.
   */
  constructor(
    sql: SqlStorage,
    org: OrgId,
    removed: (ids: ReadonlyArray<string>) => void = () => {},
  ) {
    this.#sql = sql;
    this.#org = org;
    this.#removed = removed;

    for (const statement of SCHEMA) sql.exec(statement);

    // A key the first version revoked was kept marked; none is kept any more.
    sql.exec(`DELETE FROM proxy_keys WHERE revoked_at IS NOT NULL`);

    sql.exec(
      `INSERT OR IGNORE INTO proxy_key_settings (id, access_clients) VALUES (1, ?)`,
      org === GLOBAL_ORG ? 1 : 0,
    );
  }

  // --- settings -----------------------------------------------------------------------------------------------

  /** Whether the proxy routes still accept an Access sign-in instead of an API key. */
  accessClients(): boolean {
    return (
      this.#sql
        .exec<SettingsRow>(`SELECT access_clients FROM proxy_key_settings WHERE id = 1`)
        .toArray()[0]?.access_clients === 1
    );
  }

  setAccessClients(on: boolean): void {
    this.#sql.exec(`UPDATE proxy_key_settings SET access_clients = ? WHERE id = 1`, on ? 1 : 0);
  }

  // --- keys ---------------------------------------------------------------------------------------------------

  /** The org's keys, or one member's, newest first; keys that have expired at `now` are deleted first. */
  list(memberId: string | undefined, now: number): ReadonlyArray<ApiKeyRecord> {
    this.purgeExpired(now);

    const rows =
      memberId === undefined
        ? this.#sql.exec<KeyRow>(`SELECT ${COLUMNS} FROM proxy_keys ORDER BY created_at DESC, id`)
        : this.#sql.exec<KeyRow>(
            `SELECT ${COLUMNS} FROM proxy_keys WHERE member_id = ? ORDER BY created_at DESC, id`,
            memberId,
          );

    return rows.toArray().map(record);
  }

  get(id: string): ApiKeyRecord | undefined {
    const row = this.#row(id);

    return row === undefined ? undefined : record(row);
  }

  /**
   * Issues a key to `memberId` (the caller checked that they are a member). Answers the whole key, which is not
   * stored: the member sees it this once.
   */
  create(
    input: { readonly memberId: string; readonly name: string; readonly expiresAt?: number },
    now: number,
  ): ApiKeyResult<{ readonly record: ApiKeyRecord; readonly key: string }> {
    const name = cleanName(input.name);

    if (name === undefined) return refuse("invalid_name", MESSAGES.invalidName);

    if (
      input.expiresAt !== undefined &&
      (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now)
    )
      return refuse("invalid_expiry", MESSAGES.invalidExpiry);

    this.purgeExpired(now);

    if (
      this.#count(`SELECT COUNT(*) AS n FROM proxy_keys WHERE member_id = ?`, input.memberId) >=
      MAX_KEYS_PER_MEMBER
    )
      return refuse("too_many_keys", MESSAGES.tooManyKeys);

    let minted = mintApiKey(this.#org);

    while (this.#row(minted.keyId) !== undefined) minted = mintApiKey(this.#org);

    this.#sql.exec(
      `INSERT INTO proxy_keys (id, member_id, name, hash, prefix, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      minted.keyId,
      input.memberId,
      name,
      minted.hash,
      minted.prefix,
      now,
      input.expiresAt ?? null,
    );

    const created = this.get(minted.keyId);

    if (created === undefined) throw new Error("the API key just written is missing");

    return { ok: true, value: { record: created, key: minted.key } };
  }

  /**
   * Revokes a key at once by deleting it: the next request with it is refused (the Worker's cache of verified keys
   * keeps it for at most its short lifetime, `access/api-key.ts`). `memberId` limits the call to that member's keys:
   * another member's key answers as unknown. The answer is the key as it was, marked revoked at `now`; revoking it
   * again finds nothing.
   */
  revoke(id: string, now: number, memberId?: string): ApiKeyResult<ApiKeyRecord> {
    const row = this.#row(id);

    if (row === undefined || (memberId !== undefined && row.member_id !== memberId))
      return refuse("api_key_not_found", MESSAGES.notFound);

    this.#sql.exec(`DELETE FROM proxy_keys WHERE id = ?`, id);
    this.#removed([id]);

    return { ok: true, value: { ...record(row), revokedAt: now } };
  }

  /** Deletes every key that has expired at `now`, whoever's; answers how many. */
  purgeExpired(now: number): number {
    const ids = this.#sql
      .exec<{ id: string }>(
        `SELECT id FROM proxy_keys WHERE expires_at IS NOT NULL AND expires_at <= ?`,
        now,
      )
      .toArray()
      .map((row) => row.id);

    if (ids.length === 0) return 0;
    this.#sql.exec(`DELETE FROM proxy_keys WHERE expires_at IS NOT NULL AND expires_at <= ?`, now);
    this.#removed(ids);

    return ids.length;
  }

  /** Deletes every key of a member who leaves the org (ADR 0027). */
  removeMemberKeys(memberId: string): void {
    const ids = this.#sql
      .exec<{ id: string }>(`SELECT id FROM proxy_keys WHERE member_id = ?`, memberId)
      .toArray()
      .map((row) => row.id);

    this.#sql.exec(`DELETE FROM proxy_keys WHERE member_id = ?`, memberId);
    this.#removed(ids);
  }

  /**
   * Checks a presented key: its id must be stored with the same hash (compared in constant time) and not expired at
   * `now`; an expired key is deleted. Records when the key was last used, at most once per {@link LAST_USED_RESOLUTION_MS}.
   */
  check(keyId: string, hash: string, now: number): ApiKeyCheck {
    const row = isKeyId(keyId) ? this.#row(keyId) : undefined;

    if (row === undefined || !sameHash(row.hash, hash)) return { ok: false, reason: "unknown" };

    if (row.expires_at !== null && now >= row.expires_at) {
      this.#sql.exec(`DELETE FROM proxy_keys WHERE id = ?`, keyId);
      this.#removed([keyId]);

      return { ok: false, reason: "expired" };
    }

    if (row.last_used_at === null || now - row.last_used_at >= LAST_USED_RESOLUTION_MS)
      this.#sql.exec(`UPDATE proxy_keys SET last_used_at = ? WHERE id = ?`, now, keyId);

    return {
      ok: true,
      memberId: row.member_id,
      ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    };
  }

  #row(id: string): KeyRow | undefined {
    return this.#sql
      .exec<KeyRow>(`SELECT ${COLUMNS} FROM proxy_keys WHERE id = ?`, id)
      .toArray()[0];
  }

  #count(sql: string, ...bindings: Array<SqlStorageValue>): number {
    return this.#sql.exec<CountRow>(sql, ...bindings).toArray()[0]?.n ?? 0;
  }
}
