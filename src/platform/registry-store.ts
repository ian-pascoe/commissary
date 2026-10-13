/**
 * The Platform registry's tables (ADR 0021), in the SQLite database of the `Platform` Durable Object: the deployment's
 * orgs, and an index of which orgs each person (email) and each Access service token belong to. New in the Workers
 * port.
 *
 * The orgs table is the registry's own data. The index is not: each org's ControlPlane stays authoritative for its
 * membership, and the registry only keeps a copy for routing, so {@link PlatformStore.replaceOrgIndex} rebuilds one org's
 * rows from what its ControlPlane says. The first start creates the org `global` (slug `default`), the deployment that
 * existed before orgs, so upgrading needs no settings and moves no data.
 */
import { Schema } from "effect";
import { DEFAULT_ORG_SLUG, GLOBAL_ORG, OrgId, OrgSlug } from "./org.ts";

/** An org as the registry lists it. */
export interface OrgRecord {
  /** Permanent: names the org's ControlPlane and every name derived from it. */
  readonly id: OrgId;
  /** Addresses the org in URLs; unique, renamable. */
  readonly slug: OrgSlug;
  readonly name: string;
  /** Epoch milliseconds. */
  readonly createdAt: number;
}

export type OrgInput = { readonly slug: string; readonly name: string };

export type OrgPatch = { readonly slug?: string; readonly name?: string };

/** Why an org write was refused; `message` is fixed text, safe to show. */
export type OrgWriteResult =
  | { readonly ok: true; readonly org: OrgRecord }
  | {
      readonly ok: false;
      readonly error: "invalid_slug" | "invalid_name" | "slug_taken" | "not_found";
      readonly message: string;
    };

/** What a repair of one org's index changed. */
export type IndexRepair =
  | {
      readonly ok: true;
      readonly members: number;
      readonly serviceTokens: number;
      /** Service tokens the org lists that another org already holds: kept with that org, not moved. */
      readonly conflicts: ReadonlyArray<string>;
    }
  | { readonly ok: false; readonly error: "not_found" };

/** The org list and index of one org as its ControlPlane states them. */
export interface OrgIndex {
  readonly emails: ReadonlyArray<string>;
  readonly serviceTokens: ReadonlyArray<string>;
}

const MAX_NAME_LENGTH = 100;

/** A display name: 1 to 100 characters after trimming, without control characters. */
const cleanName = (name: string): string | undefined => {
  const trimmed = name.trim();
  // Code points, so one emoji counts as one character.
  const characters = Array.from(trimmed);

  const control = characters.some((character) => {
    const code = character.codePointAt(0) ?? 0;

    return code < 0x20 || code === 0x7f;
  });

  return characters.length > 0 && characters.length <= MAX_NAME_LENGTH && !control
    ? trimmed
    : undefined;
};

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

interface OrgRow {
  id: string;
  slug: string;
  name: string;
  created_at: number;
  [column: string]: SqlStorageValue;
}

const SLUG_PROBLEM =
  "an org slug is 1 to 63 lowercase letters, digits and inner hyphens (it appears in URLs)";

const NAME_PROBLEM = `an org name is 1 to ${MAX_NAME_LENGTH} characters without control characters`;

export class PlatformStore {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage, now: number = Date.now()) {
    this.#sql = sql;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS orgs (
         id TEXT PRIMARY KEY,
         slug TEXT NOT NULL UNIQUE,
         name TEXT NOT NULL,
         created_at INTEGER NOT NULL
       )`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS org_members (
         email TEXT NOT NULL,
         org_id TEXT NOT NULL,
         PRIMARY KEY (email, org_id)
       )`,
    );
    sql.exec(`CREATE INDEX IF NOT EXISTS org_members_by_org ON org_members (org_id)`);

    sql.exec(
      `CREATE TABLE IF NOT EXISTS org_service_tokens (
         client_id TEXT PRIMARY KEY,
         org_id TEXT NOT NULL
       )`,
    );
    sql.exec(`CREATE INDEX IF NOT EXISTS org_service_tokens_by_org ON org_service_tokens (org_id)`);
    // The deployment that existed before orgs. Left alone when it exists (a platform admin may have renamed it).
    sql.exec(
      `INSERT OR IGNORE INTO orgs (id, slug, name, created_at) VALUES (?, ?, ?, ?)`,
      GLOBAL_ORG,
      DEFAULT_ORG_SLUG,
      "Default",
      now,
    );
  }

  #record(row: OrgRow): OrgRecord {
    return {
      // SAFETY: only ids and slugs that passed `OrgId` / `OrgSlug` are ever inserted (`createOrg`, `updateOrg`, the seed).
      id: row.id as OrgId,
      // SAFETY: as above.
      slug: row.slug as OrgSlug,
      name: row.name,
      createdAt: row.created_at,
    };
  }

  /** Every org, the seeded `global` first and then oldest first. */
  listOrgs(): ReadonlyArray<OrgRecord> {
    return this.#sql
      .exec<OrgRow>(
        `SELECT id, slug, name, created_at FROM orgs ORDER BY id <> 'global', created_at, id`,
      )
      .toArray()
      .map((row) => this.#record(row));
  }

  orgBySlug(slug: string): OrgRecord | undefined {
    const row = this.#sql
      .exec<OrgRow>(`SELECT id, slug, name, created_at FROM orgs WHERE slug = ?`, slug)
      .toArray()[0];

    return row === undefined ? undefined : this.#record(row);
  }

  orgById(id: string): OrgRecord | undefined {
    const row = this.#sql
      .exec<OrgRow>(`SELECT id, slug, name, created_at FROM orgs WHERE id = ?`, id)
      .toArray()[0];

    return row === undefined ? undefined : this.#record(row);
  }

  /** Creates an org under a fresh permanent id; the slug must be new. */
  createOrg(input: OrgInput, now: number): OrgWriteResult {
    if (!Schema.is(OrgSlug)(input.slug))
      return { ok: false, error: "invalid_slug", message: SLUG_PROBLEM };
    const name = cleanName(input.name);

    if (name === undefined) return { ok: false, error: "invalid_name", message: NAME_PROBLEM };

    if (this.orgBySlug(input.slug) !== undefined)
      return { ok: false, error: "slug_taken", message: `the slug “${input.slug}” is in use` };

    // Never derived from the slug: a renamed org's old slug may be taken again, and its id must stay unique.
    const id = OrgId.make(`org-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`);

    this.#sql.exec(
      `INSERT INTO orgs (id, slug, name, created_at) VALUES (?, ?, ?, ?)`,
      id,
      input.slug,
      name,
      now,
    );

    const org = this.orgById(id);

    if (org === undefined) throw new Error("the org just created is missing");

    return { ok: true, org };
  }

  /** Renames the org addressed by `slug`: its display name, its slug, or both. The id never changes. */
  updateOrg(slug: string, patch: OrgPatch): OrgWriteResult {
    const current = this.orgBySlug(slug);

    if (current === undefined)
      return { ok: false, error: "not_found", message: `no org has the slug “${slug}”` };
    const nextSlug = patch.slug ?? current.slug;

    if (!Schema.is(OrgSlug)(nextSlug))
      return { ok: false, error: "invalid_slug", message: SLUG_PROBLEM };
    const nextName = patch.name === undefined ? current.name : cleanName(patch.name);

    if (nextName === undefined) return { ok: false, error: "invalid_name", message: NAME_PROBLEM };
    const holder = this.orgBySlug(nextSlug);

    if (holder !== undefined && holder.id !== current.id)
      return { ok: false, error: "slug_taken", message: `the slug “${nextSlug}” is in use` };

    this.#sql.exec(
      `UPDATE orgs SET slug = ?, name = ? WHERE id = ?`,
      nextSlug,
      nextName,
      current.id,
    );

    return { ok: true, org: { ...current, slug: nextSlug, name: nextName } };
  }

  /** The orgs `email` belongs to, in listing order. */
  orgsOfEmail(email: string): ReadonlyArray<OrgRecord> {
    return this.#sql
      .exec<OrgRow>(
        `SELECT o.id, o.slug, o.name, o.created_at FROM orgs o
         JOIN org_members m ON m.org_id = o.id WHERE m.email = ? ORDER BY o.id <> 'global', o.created_at, o.id`,
        normalizeEmail(email),
      )
      .toArray()
      .map((row) => this.#record(row));
  }

  /** The org an Access service token (by Client ID) belongs to. */
  orgOfServiceToken(clientId: string): OrgRecord | undefined {
    const row = this.#sql
      .exec<OrgRow>(
        `SELECT o.id, o.slug, o.name, o.created_at FROM orgs o
         JOIN org_service_tokens t ON t.org_id = o.id WHERE t.client_id = ?`,
        clientId.trim(),
      )
      .toArray()[0];

    return row === undefined ? undefined : this.#record(row);
  }

  /**
   * Rebuilds the index rows of `org` from its ControlPlane's own lists: whatever the registry held for the org is
   * replaced. A service token another org already holds stays with that org and is reported, since a token belongs to
   * one org.
   */
  replaceOrgIndex(org: string, index: OrgIndex): IndexRepair {
    if (this.orgById(org) === undefined) return { ok: false, error: "not_found" };

    const emails = [...new Set(index.emails.map(normalizeEmail).filter((email) => email !== ""))];

    const tokens = [
      ...new Set(index.serviceTokens.map((token) => token.trim()).filter((token) => token !== "")),
    ];

    const conflicts: Array<string> = [];

    this.#sql.exec(`DELETE FROM org_members WHERE org_id = ?`, org);
    this.#sql.exec(`DELETE FROM org_service_tokens WHERE org_id = ?`, org);

    for (const email of emails)
      this.#sql.exec(`INSERT INTO org_members (email, org_id) VALUES (?, ?)`, email, org);

    for (const token of tokens) {
      const added = this.#sql.exec(
        `INSERT OR IGNORE INTO org_service_tokens (client_id, org_id) VALUES (?, ?)`,
        token,
        org,
      );

      if (added.rowsWritten === 0) conflicts.push(token);
    }

    return {
      ok: true,
      members: emails.length,
      serviceTokens: tokens.length - conflicts.length,
      conflicts,
    };
  }
}
