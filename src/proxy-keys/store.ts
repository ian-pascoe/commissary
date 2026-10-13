/**
 * An org's proxy keys inside its ControlPlane Durable Object (SQLite; ADR 0022). New in the Workers port, no Go
 * counterpart.
 *
 * - **proxy_keys**: one row per key: its id, the member it belongs to, a name, the SHA-256 of the whole key (never the
 *   key itself: a hash needs no sealing), the visible prefix, and when it was created, last used, expires and was
 *   revoked. A revoked key stays listed and is refused from then on.
 * - **proxy_key_settings**: one row of org-wide state: whether the org still accepts Access sign-ins (the clients of
 *   the time before proxy keys) on the proxy routes. On for `global`, where clients signed in through Access before,
 *   off for every other org.
 *
 * All methods are synchronous; refusals are plain data (`ProxyKeyRefused`). Times are the caller's clock (epoch
 * milliseconds), so the Worker's `Clock` drives them.
 */
import type { OrgRole } from "../members/roles.ts";
import { GLOBAL_ORG, type OrgId } from "../platform/org.ts";
import { cleanName, MAX_NAME_LENGTH } from "../platform/registry-store.ts";
import { isKeyId, mintProxyKey } from "./key.ts";

export interface ProxyKeyRecord {
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

export type ProxyKeyErrorCode =
  | "invalid_name"
  | "invalid_expiry"
  | "too_many_keys"
  | "proxy_key_not_found";

/** A refused write; `message` is fixed text, safe to show. */
export interface ProxyKeyRefused {
  readonly ok: false;
  readonly error: ProxyKeyErrorCode;
  readonly message: string;
}

export type ProxyKeyResult<A> = { readonly ok: true; readonly value: A } | ProxyKeyRefused;

/** Why a presented key was refused; the client sees the same `Invalid API key` for each. */
export type ProxyKeyRejection = "unknown" | "revoked" | "expired";

export type ProxyKeyCheck =
  | { readonly ok: true; readonly memberId: string; readonly expiresAt?: number }
  | { readonly ok: false; readonly reason: ProxyKeyRejection };

/** A key as the org's lists show it: with the email of its member, while they are one. */
export interface ProxyKeyListing extends ProxyKeyRecord {
  readonly memberEmail?: string | undefined;
}

/** A key was asked for a member the org does not have. */
export interface MemberNotFound {
  readonly ok: false;
  readonly error: "member_not_found";
  readonly message: string;
}

/** The ControlPlane's answer to a presented key: its live member and their role, or why it is refused. */
export type ProxyKeyVerdict =
  | {
      readonly ok: true;
      readonly memberId: string;
      readonly email: string;
      readonly role: OrgRole;
      /** When the key expires (epoch ms), so a cache of verified keys never keeps it longer. */
      readonly expiresAt?: number;
    }
  | { readonly ok: false; readonly reason: ProxyKeyRejection };

/** The org accepts only proxy keys on its proxy routes: an Access sign-in is not admitted there. */
export interface ClientsUseProxyKeys {
  readonly proxyKeysOnly: true;
}

/** At most this many keys (revoked ones included) per member, so a member cannot fill the org's storage. */
export const MAX_KEYS_PER_MEMBER = 100;

/** `last_used_at` is written at most this often per key, so busy clients do not write on every request. */
export const LAST_USED_RESOLUTION_MS = 60_000;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS proxy_keys (
     id TEXT PRIMARY KEY, member_id TEXT NOT NULL, name TEXT NOT NULL, hash TEXT NOT NULL, prefix TEXT NOT NULL,
     created_at INTEGER NOT NULL, created_by TEXT NOT NULL, last_used_at INTEGER, expires_at INTEGER,
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
  tooManyKeys: `a member holds at most ${MAX_KEYS_PER_MEMBER} proxy keys`,
  notFound: "no proxy key has this id",
} as const;

const refuse = (error: ProxyKeyErrorCode, message: string): ProxyKeyRefused => ({
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

const record = (row: KeyRow): ProxyKeyRecord => ({
  id: row.id,
  memberId: row.member_id,
  name: row.name,
  prefix: row.prefix,
  createdAt: row.created_at,
  ...(row.last_used_at === null ? {} : { lastUsedAt: row.last_used_at }),
  ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
  ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
});

export class ProxyKeyStore {
  readonly #sql: SqlStorage;
  readonly #org: OrgId;

  /** `org`: the org the keys name; Access sign-ins stay accepted on the proxy routes of `global` until turned off. */
  constructor(sql: SqlStorage, org: OrgId) {
    this.#sql = sql;
    this.#org = org;

    for (const statement of SCHEMA) sql.exec(statement);

    sql.exec(
      `INSERT OR IGNORE INTO proxy_key_settings (id, access_clients) VALUES (1, ?)`,
      org === GLOBAL_ORG ? 1 : 0,
    );
  }

  // --- settings -----------------------------------------------------------------------------------------------

  /** Whether the proxy routes still accept an Access sign-in instead of a proxy key. */
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

  /** The org's keys, or one member's, newest first. */
  list(memberId?: string): ReadonlyArray<ProxyKeyRecord> {
    const rows =
      memberId === undefined
        ? this.#sql.exec<KeyRow>(`SELECT ${COLUMNS} FROM proxy_keys ORDER BY created_at DESC, id`)
        : this.#sql.exec<KeyRow>(
            `SELECT ${COLUMNS} FROM proxy_keys WHERE member_id = ? ORDER BY created_at DESC, id`,
            memberId,
          );

    return rows.toArray().map(record);
  }

  get(id: string): ProxyKeyRecord | undefined {
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
    by: string,
  ): ProxyKeyResult<{ readonly record: ProxyKeyRecord; readonly key: string }> {
    const name = cleanName(input.name);

    if (name === undefined) return refuse("invalid_name", MESSAGES.invalidName);

    if (
      input.expiresAt !== undefined &&
      (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now)
    )
      return refuse("invalid_expiry", MESSAGES.invalidExpiry);

    if (
      this.#count(`SELECT COUNT(*) AS n FROM proxy_keys WHERE member_id = ?`, input.memberId) >=
      MAX_KEYS_PER_MEMBER
    )
      return refuse("too_many_keys", MESSAGES.tooManyKeys);

    let minted = mintProxyKey(this.#org);

    while (this.#row(minted.keyId) !== undefined) minted = mintProxyKey(this.#org);

    this.#sql.exec(
      `INSERT INTO proxy_keys (id, member_id, name, hash, prefix, created_at, created_by, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      minted.keyId,
      input.memberId,
      name,
      minted.hash,
      minted.prefix,
      now,
      by,
      input.expiresAt ?? null,
    );

    const created = this.get(minted.keyId);

    if (created === undefined) throw new Error("the proxy key just written is missing");

    return { ok: true, value: { record: created, key: minted.key } };
  }

  /**
   * Revokes a key at once: the next request with it is refused (the Worker's cache of verified keys keeps it for at
   * most its short lifetime, `access/proxy-key.ts`). `memberId` limits the call to that member's keys: another
   * member's key answers as unknown. Revoking a revoked key keeps its first revocation time.
   */
  revoke(id: string, now: number, memberId?: string): ProxyKeyResult<ProxyKeyRecord> {
    const row = this.#row(id);

    if (row === undefined || (memberId !== undefined && row.member_id !== memberId))
      return refuse("proxy_key_not_found", MESSAGES.notFound);

    this.#sql.exec(
      `UPDATE proxy_keys SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?`,
      now,
      id,
    );

    const revoked = this.get(id);

    if (revoked === undefined) throw new Error("the proxy key just revoked is missing");

    return { ok: true, value: revoked };
  }

  /** Deletes every key of a member who leaves the org (ADR 0027). */
  removeMemberKeys(memberId: string): void {
    this.#sql.exec(`DELETE FROM proxy_keys WHERE member_id = ?`, memberId);
  }

  /**
   * Checks a presented key: its id must be stored with the same hash (compared in constant time), not revoked and not
   * expired at `now`. Records when the key was last used, at most once per {@link LAST_USED_RESOLUTION_MS}.
   */
  check(keyId: string, hash: string, now: number): ProxyKeyCheck {
    const row = isKeyId(keyId) ? this.#row(keyId) : undefined;

    if (row === undefined || !sameHash(row.hash, hash)) return { ok: false, reason: "unknown" };

    if (row.revoked_at !== null) return { ok: false, reason: "revoked" };

    if (row.expires_at !== null && now >= row.expires_at) return { ok: false, reason: "expired" };

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
