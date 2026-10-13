/**
 * An org's members, teams and service tokens inside its ControlPlane Durable Object (SQLite; ADR 0022, ADR 0025). New
 * in the Workers port, no Go counterpart.
 *
 * - **members**: the people of the org, by lowercased email, each with one role (`roles.ts`). Their id is permanent
 *   while they stay a member and names them in usage records (`member_id`).
 * - **teams**: named groups of members; a member can be on several. Removing a member takes them off every team.
 * - **service tokens**: Access service tokens (by Client ID) registered to the org with a role.
 * - **membership**: one row of org-wide state: the auto-join setting (on for `global`, off for new orgs), whether the
 *   `global` admin lists were migrated, and a counter of changes the Platform registry's index has caught up with.
 *
 * The ControlPlane is authoritative; the Platform registry keeps a copy of which orgs each person and service token
 * belong to (`index`, pushed by the Worker, `admission.ts`). Writes take the acting principal's role (`Actor`) and
 * check it against the target here, so the check and the write are one step under the Durable Object's input gate.
 * All methods are synchronous; refusals are plain data (`MemberRefused`).
 */
import { GLOBAL_ORG, type OrgId } from "../platform/org.ts";
import { cleanName, MAX_NAME_LENGTH } from "../platform/registry-store.ts";
import {
  type Actor,
  isOrgRole,
  mayChangeRoles,
  mayGrantTokenRole,
  mayManageMember,
  mayRemoveToken,
  type OrgRole,
} from "./roles.ts";

/** Who a request is, as the store looks it up: a person by email, a service token by Client ID. */
export type PrincipalRef =
  | { readonly kind: "user"; readonly email: string }
  | { readonly kind: "service"; readonly clientId: string };

/** A principal's place in the org. */
export interface Admission {
  readonly role: OrgRole;
  /** The member id of a person; absent for a service token. */
  readonly memberId?: string;
  /** The person joined just now (auto-join). */
  readonly joined: boolean;
  /** The Platform registry's index is behind the org's members and service tokens (`index`). */
  readonly indexStale: boolean;
}

export interface MemberRecord {
  readonly id: string;
  readonly email: string;
  readonly role: OrgRole;
  /** Epoch milliseconds. */
  readonly addedAt: number;
  readonly teams: ReadonlyArray<string>;
}

export interface TeamRecord {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  readonly members: ReadonlyArray<string>;
}

export interface ServiceTokenRecord {
  readonly clientId: string;
  readonly name: string;
  readonly role: OrgRole;
  readonly addedAt: number;
}

/** The org-wide membership settings. */
export interface MembershipSettingsWire {
  /** Every person Access admits joins as a plain member on their first request. */
  readonly autoJoin: boolean;
}

/** What the Platform registry indexes for the org, and the change it reflects. */
export interface MembershipIndex {
  readonly emails: ReadonlyArray<string>;
  readonly serviceTokens: ReadonlyArray<string>;
  /** The change counter the lists reflect; hand it back to `markIndexSynced`. */
  readonly counter: number;
  /** Whether the registry has caught up with `counter`. */
  readonly synced: boolean;
}

export type MemberErrorCode =
  | "invalid_email"
  | "invalid_role"
  | "invalid_name"
  | "invalid_client_id"
  | "member_exists"
  | "team_exists"
  | "service_token_exists"
  | "member_not_found"
  | "team_not_found"
  | "service_token_not_found"
  | "owner_required"
  | "admin_required"
  | "service_token_owner_required"
  | "last_owner";

/** A refused write; `message` is fixed text, safe to show. */
export interface MemberRefused {
  readonly ok: false;
  readonly error: MemberErrorCode;
  readonly message: string;
}

export type MemberResult<A> = { readonly ok: true; readonly value: A } | MemberRefused;

/** The admin lists of the config document from before members (`access.admin-*`) and the deployment's admins. */
export interface LegacyAdmins {
  /** Platform admin emails at the time of the migration: they become org owners. */
  readonly owners: ReadonlyArray<string>;
  /** `access.admin-emails`: they become org admins. */
  readonly admins: ReadonlyArray<string>;
  /** `access.admin-service-tokens`: registered with the owner role. */
  readonly serviceTokens: ReadonlyArray<string>;
}

/** Who added the members a migration or auto-join created. */
export const MIGRATION_ACTOR = "migration";

export const AUTO_JOIN_ACTOR = "auto-join";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS membership (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     auto_join INTEGER NOT NULL,
     admins_migrated INTEGER NOT NULL,
     counter INTEGER NOT NULL,
     index_synced INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS members (
     id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, role TEXT NOT NULL, added_at INTEGER NOT NULL,
     added_by TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS teams (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS team_members (
     team_id TEXT NOT NULL, member_id TEXT NOT NULL, PRIMARY KEY (team_id, member_id)
   )`,
  `CREATE INDEX IF NOT EXISTS team_members_by_member ON team_members (member_id)`,
  `CREATE TABLE IF NOT EXISTS service_tokens (
     client_id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, added_at INTEGER NOT NULL,
     added_by TEXT NOT NULL
   )`,
  // People and tokens an org admin removed: auto-join does not let them back in until they are added again.
  // `principal` is `user:<email>` or `service:<client id>`.
  `CREATE TABLE IF NOT EXISTS removed_principals (
     principal TEXT PRIMARY KEY, removed_at INTEGER NOT NULL
   )`,
];

const removedUser = (email: string) => `user:${email}`;

const removedToken = (clientId: string) => `service:${clientId}`;

interface StateRow {
  auto_join: number;
  admins_migrated: number;
  counter: number;
  index_synced: number;
  [column: string]: SqlStorageValue;
}

interface MemberRow {
  id: string;
  email: string;
  role: string;
  added_at: number;
  [column: string]: SqlStorageValue;
}

interface TeamRow {
  id: string;
  name: string;
  created_at: number;
  [column: string]: SqlStorageValue;
}

interface TokenRow {
  client_id: string;
  name: string;
  role: string;
  added_at: number;
  [column: string]: SqlStorageValue;
}

interface LinkRow {
  team_id: string;
  member_id: string;
  [column: string]: SqlStorageValue;
}

interface CountRow {
  n: number;
  [column: string]: SqlStorageValue;
}

const MAX_EMAIL_LENGTH = 254;

const EMAIL = /^[^\s@,;<>"]+@[^\s@,;<>"]+$/;

/** An Access Client ID (`<hex>.access`) or any id of that alphabet. */
const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export const validEmail = (email: string): boolean =>
  email.length <= MAX_EMAIL_LENGTH && EMAIL.test(email);

const refuse = (error: MemberErrorCode, message: string): MemberRefused => ({
  ok: false,
  error,
  message,
});

const ok = <A>(value: A): MemberResult<A> => ({ ok: true, value });

const MESSAGES = {
  invalidEmail: "an email address is needed, such as name@example.com",
  invalidRole: "a role is owner, admin or member",
  invalidName: `a name is 1 to ${MAX_NAME_LENGTH} characters without control characters`,
  invalidClientId:
    "a service token is named by its Access Client ID (letters, digits, '.', '_', '-')",
  memberNotFound: "no member has this id",
  teamNotFound: "no team has this id",
  tokenNotFound: "no service token with this Client ID is registered to the org",
  ownerRequired: "only an org owner can do this",
  adminRequired: "only an org admin can do this",
  tokenOwnerRequired:
    "giving a service token a role above member needs a service token that is an org owner, or a platform admin",
  lastOwner: "an org with members keeps at least one owner: make someone else an owner first",
} as const;

const role = (value: string): OrgRole => (isOrgRole(value) ? value : "member");

const freshId = (prefix: string): string =>
  `${prefix}-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;

export class MemberStore {
  readonly #sql: SqlStorage;
  readonly #org: OrgId;
  readonly #transaction: <T>(body: () => T) => T;
  readonly #now: () => number;

  /**
   * `org`: auto-join starts on for `global` (self-hosted deployments keep admitting everyone Access admits) and off
   * for every other org; `transaction` runs a body in one storage transaction (`ctx.storage.transactionSync`).
   */
  constructor(
    sql: SqlStorage,
    org: OrgId,
    transaction: <T>(body: () => T) => T,
    now: () => number = Date.now,
  ) {
    this.#sql = sql;
    this.#org = org;
    this.#transaction = transaction;
    this.#now = now;

    for (const statement of SCHEMA) sql.exec(statement);

    sql.exec(
      `INSERT OR IGNORE INTO membership (id, auto_join, admins_migrated, counter, index_synced)
       VALUES (1, ?, 0, 0, 0)`,
      org === GLOBAL_ORG ? 1 : 0,
    );
  }

  // --- the global migration -----------------------------------------------------------------------------------

  /** Whether {@link migrateAdmins} has run (it runs once per org). */
  adminsMigrated(): boolean {
    return this.#state().admins_migrated === 1;
  }

  /**
   * Turns the admin lists from before members into members of `global` (ADR 0022): the platform admins at the time
   * become org owners, `access.admin-emails` org admins, `access.admin-service-tokens` service tokens with the owner
   * role. Another org only records that it ran: its config admin lists never granted anything. Runs once (idempotent);
   * call it inside the transaction that also removes the lists from the config.
   */
  migrateAdmins(legacy: LegacyAdmins): void {
    if (this.adminsMigrated()) return;
    const now = this.#now();

    if (this.#org === GLOBAL_ORG) {
      const placed = new Map<string, OrgRole>();

      for (const email of legacy.admins.map(normalizeEmail)) placed.set(email, "admin");

      for (const email of legacy.owners.map(normalizeEmail)) placed.set(email, "owner");

      for (const [email, granted] of placed) {
        if (!validEmail(email)) continue;
        const existing = this.#memberByEmail(email);

        if (existing === undefined) this.#insertMember(email, granted, now, MIGRATION_ACTOR);
        else if (granted === "owner" || existing.role === "member")
          this.#sql.exec(`UPDATE members SET role = ? WHERE id = ?`, granted, existing.id);
      }

      for (const clientId of new Set(legacy.serviceTokens.map((id) => id.trim()))) {
        if (!CLIENT_ID.test(clientId)) continue;
        this.#sql.exec(
          `INSERT INTO service_tokens (client_id, name, role, added_at, added_by) VALUES (?, ?, 'owner', ?, ?)
           ON CONFLICT (client_id) DO UPDATE SET role = 'owner'`,
          clientId,
          clientId,
          now,
          MIGRATION_ACTOR,
        );
      }

      this.#changed();
    }

    this.#sql.exec(`UPDATE membership SET admins_migrated = 1 WHERE id = 1`);
  }

  // --- admission ----------------------------------------------------------------------------------------------

  /**
   * The role of `principal` in the org, `undefined` when it has none. With `autoJoin` and the org's auto-join setting
   * on, a person who is not a member joins as a plain member, and an unregistered service token is admitted as a plain
   * member without being stored (register it to give it a role). Someone an org admin removed does not join again
   * until they are added back.
   */
  admit(principal: PrincipalRef, autoJoin: boolean): Admission | undefined {
    const state = this.#state();
    const indexStale = state.index_synced < state.counter;

    if (principal.kind === "service") {
      const clientId = principal.clientId.trim();
      const token = this.#token(clientId);

      if (token !== undefined) return { role: role(token.role), joined: false, indexStale };

      return autoJoin && state.auto_join === 1 && !this.#removed(removedToken(clientId))
        ? { role: "member", joined: false, indexStale }
        : undefined;
    }

    const email = normalizeEmail(principal.email);
    const member = this.#memberByEmail(email);

    if (member !== undefined)
      return { role: role(member.role), memberId: member.id, joined: false, indexStale };

    if (
      !autoJoin ||
      state.auto_join !== 1 ||
      !validEmail(email) ||
      this.#removed(removedUser(email))
    )
      return undefined;

    const id = this.#transaction(() => {
      const joined = this.#insertMember(email, "member", this.#now(), AUTO_JOIN_ACTOR);
      this.#changed();

      return joined;
    });

    return { role: "member", memberId: id, joined: true, indexStale: true };
  }

  // --- settings -----------------------------------------------------------------------------------------------

  autoJoin(): boolean {
    return this.#state().auto_join === 1;
  }

  setAutoJoin(on: boolean): void {
    this.#sql.exec(`UPDATE membership SET auto_join = ? WHERE id = 1`, on ? 1 : 0);
  }

  // --- members ------------------------------------------------------------------------------------------------

  members(): ReadonlyArray<MemberRecord> {
    const teams = this.#teamsByMember();

    return this.#sql
      .exec<MemberRow>(`SELECT id, email, role, added_at FROM members ORDER BY added_at, email`)
      .toArray()
      .map((row) => this.#memberRecord(row, teams.get(row.id) ?? []));
  }

  member(id: string): MemberRecord | undefined {
    const row = this.#memberById(id);

    return row === undefined ? undefined : this.#memberRecord(row, this.#teamsOf(id));
  }

  /** Adds a person by email; they get access the next time they sign in. */
  addMember(
    input: { readonly email: string; readonly role: string },
    actor: Actor,
    by: string,
  ): MemberResult<MemberRecord> {
    const email = normalizeEmail(input.email);

    if (!validEmail(email)) return refuse("invalid_email", MESSAGES.invalidEmail);

    if (!isOrgRole(input.role)) return refuse("invalid_role", MESSAGES.invalidRole);

    if (!mayManageMember(actor, input.role)) return this.#denied(input.role);

    if (this.#memberByEmail(email) !== undefined)
      return refuse("member_exists", `${email} is already a member`);
    const granted = input.role;

    const id = this.#transaction(() => {
      const added = this.#insertMember(email, granted, this.#now(), by);
      this.#restore(removedUser(email));
      this.#changed();

      return added;
    });

    return this.#found(id);
  }

  /** Changes a member's role: org owners only, and an org with members keeps at least one owner. */
  setMemberRole(id: string, next: string, actor: Actor): MemberResult<MemberRecord> {
    if (!isOrgRole(next)) return refuse("invalid_role", MESSAGES.invalidRole);
    const current = this.#memberById(id);

    if (current === undefined) return refuse("member_not_found", MESSAGES.memberNotFound);

    if (!mayChangeRoles(actor)) return refuse("owner_required", MESSAGES.ownerRequired);

    if (current.role === "owner" && next !== "owner" && this.#owners() === 1)
      return refuse("last_owner", MESSAGES.lastOwner);

    this.#sql.exec(`UPDATE members SET role = ? WHERE id = ?`, next, id);

    return this.#found(id);
  }

  /** Removes a member (and their team memberships) at once: they lose access on their next request. */
  removeMember(id: string, actor: Actor): MemberResult<{ readonly email: string }> {
    const current = this.#memberById(id);

    if (current === undefined) return refuse("member_not_found", MESSAGES.memberNotFound);
    const held = role(current.role);

    if (!mayManageMember(actor, held)) return this.#denied(held);
    const others = this.#count(`SELECT COUNT(*) AS n FROM members WHERE id <> ?`, id);

    if (held === "owner" && this.#owners() === 1 && others > 0)
      return refuse("last_owner", MESSAGES.lastOwner);

    this.#transaction(() => {
      this.#sql.exec(`DELETE FROM team_members WHERE member_id = ?`, id);
      this.#sql.exec(`DELETE FROM members WHERE id = ?`, id);
      this.#tombstone(removedUser(current.email));
      this.#changed();
    });

    return ok({ email: current.email });
  }

  // --- teams --------------------------------------------------------------------------------------------------

  teams(): ReadonlyArray<TeamRecord> {
    const links = this.#sql
      .exec<LinkRow>(`SELECT team_id, member_id FROM team_members ORDER BY member_id`)
      .toArray();

    return this.#sql
      .exec<TeamRow>(`SELECT id, name, created_at FROM teams ORDER BY name_key`)
      .toArray()
      .map((row) => ({
        id: row.id,
        name: row.name,
        createdAt: row.created_at,
        members: links.filter((link) => link.team_id === row.id).map((link) => link.member_id),
      }));
  }

  team(id: string): TeamRecord | undefined {
    return this.teams().find((team) => team.id === id);
  }

  createTeam(name: string): MemberResult<TeamRecord> {
    const clean = cleanName(name);

    if (clean === undefined) return refuse("invalid_name", MESSAGES.invalidName);

    if (this.#teamByName(clean) !== undefined)
      return refuse("team_exists", `a team named “${clean}” exists`);
    const id = freshId("team");

    this.#sql.exec(
      `INSERT INTO teams (id, name, name_key, created_at) VALUES (?, ?, ?, ?)`,
      id,
      clean,
      clean.toLowerCase(),
      this.#now(),
    );

    return this.#foundTeam(id);
  }

  renameTeam(id: string, name: string): MemberResult<TeamRecord> {
    const clean = cleanName(name);

    if (clean === undefined) return refuse("invalid_name", MESSAGES.invalidName);

    if (this.#teamRow(id) === undefined) return refuse("team_not_found", MESSAGES.teamNotFound);
    const holder = this.#teamByName(clean);

    if (holder !== undefined && holder.id !== id)
      return refuse("team_exists", `a team named “${clean}” exists`);

    this.#sql.exec(
      `UPDATE teams SET name = ?, name_key = ? WHERE id = ?`,
      clean,
      clean.toLowerCase(),
      id,
    );

    return this.#foundTeam(id);
  }

  deleteTeam(id: string): MemberResult<true> {
    if (this.#teamRow(id) === undefined) return refuse("team_not_found", MESSAGES.teamNotFound);

    this.#transaction(() => {
      this.#sql.exec(`DELETE FROM team_members WHERE team_id = ?`, id);
      this.#sql.exec(`DELETE FROM teams WHERE id = ?`, id);
    });

    return ok(true);
  }

  addTeamMember(teamId: string, memberId: string): MemberResult<TeamRecord> {
    if (this.#teamRow(teamId) === undefined) return refuse("team_not_found", MESSAGES.teamNotFound);

    if (this.#memberById(memberId) === undefined)
      return refuse("member_not_found", MESSAGES.memberNotFound);

    this.#sql.exec(
      `INSERT OR IGNORE INTO team_members (team_id, member_id) VALUES (?, ?)`,
      teamId,
      memberId,
    );

    return this.#foundTeam(teamId);
  }

  removeTeamMember(teamId: string, memberId: string): MemberResult<TeamRecord> {
    if (this.#teamRow(teamId) === undefined) return refuse("team_not_found", MESSAGES.teamNotFound);

    this.#sql.exec(
      `DELETE FROM team_members WHERE team_id = ? AND member_id = ?`,
      teamId,
      memberId,
    );

    return this.#foundTeam(teamId);
  }

  /** The member ids of a team (usage filters); `undefined` for an unknown team. */
  teamMemberIds(teamId: string): ReadonlyArray<string> | undefined {
    if (this.#teamRow(teamId) === undefined) return undefined;

    return this.#sql
      .exec<LinkRow>(`SELECT member_id FROM team_members WHERE team_id = ?`, teamId)
      .toArray()
      .map((row) => row.member_id);
  }

  // --- service tokens -----------------------------------------------------------------------------------------

  serviceTokens(): ReadonlyArray<ServiceTokenRecord> {
    return this.#sql
      .exec<TokenRow>(
        `SELECT client_id, name, role, added_at FROM service_tokens ORDER BY added_at, client_id`,
      )
      .toArray()
      .map((row) => this.#tokenRecord(row));
  }

  /** Registers an Access service token with a role (`mayGrantTokenRole`). */
  registerToken(
    input: { readonly clientId: string; readonly name?: string | undefined; readonly role: string },
    actor: Actor,
    by: string,
  ): MemberResult<ServiceTokenRecord> {
    const clientId = input.clientId.trim();

    if (!CLIENT_ID.test(clientId)) return refuse("invalid_client_id", MESSAGES.invalidClientId);

    if (!isOrgRole(input.role)) return refuse("invalid_role", MESSAGES.invalidRole);
    const name = input.name === undefined ? clientId : cleanName(input.name);

    if (name === undefined) return refuse("invalid_name", MESSAGES.invalidName);

    if (!mayGrantTokenRole(actor, input.role, false)) return this.#tokenDenied(actor, input.role);

    if (this.#token(clientId) !== undefined)
      return refuse("service_token_exists", "this service token is already registered");
    const granted = input.role;

    this.#transaction(() => {
      this.#sql.exec(
        `INSERT INTO service_tokens (client_id, name, role, added_at, added_by) VALUES (?, ?, ?, ?, ?)`,
        clientId,
        name,
        granted,
        this.#now(),
        by,
      );
      this.#restore(removedToken(clientId));
      this.#changed();
    });

    return this.#foundToken(clientId);
  }

  setTokenRole(id: string, next: string, actor: Actor): MemberResult<ServiceTokenRecord> {
    if (!isOrgRole(next)) return refuse("invalid_role", MESSAGES.invalidRole);
    const clientId = id.trim();
    const token = this.#token(clientId);

    if (token === undefined) return refuse("service_token_not_found", MESSAGES.tokenNotFound);

    if (!mayGrantTokenRole(actor, next, true)) return this.#tokenDenied(actor, next);

    if (role(token.role) !== "member" && !mayRemoveToken(actor, role(token.role)))
      return this.#denied(role(token.role));

    this.#sql.exec(`UPDATE service_tokens SET role = ? WHERE client_id = ?`, next, clientId);

    return this.#foundToken(clientId);
  }

  removeToken(id: string, actor: Actor): MemberResult<true> {
    const clientId = id.trim();
    const token = this.#token(clientId);

    if (token === undefined) return refuse("service_token_not_found", MESSAGES.tokenNotFound);
    const held = role(token.role);

    if (!mayRemoveToken(actor, held)) return this.#denied(held);

    this.#transaction(() => {
      this.#sql.exec(`DELETE FROM service_tokens WHERE client_id = ?`, clientId);
      this.#tombstone(removedToken(clientId));
      this.#changed();
    });

    return ok(true);
  }

  // --- the registry's index -----------------------------------------------------------------------------------

  index(): MembershipIndex {
    const state = this.#state();

    return {
      emails: this.#sql
        .exec<MemberRow>(`SELECT id, email, role, added_at FROM members ORDER BY email`)
        .toArray()
        .map((row) => row.email),
      serviceTokens: this.#sql
        .exec<TokenRow>(
          `SELECT client_id, name, role, added_at FROM service_tokens ORDER BY client_id`,
        )
        .toArray()
        .map((row) => row.client_id),
      counter: state.counter,
      synced: state.index_synced >= state.counter,
    };
  }

  /** The registry holds the index of `counter` (never moves back). */
  markIndexSynced(counter: number): void {
    this.#sql.exec(
      `UPDATE membership SET index_synced = MAX(index_synced, ?) WHERE id = 1`,
      Math.trunc(counter),
    );
  }

  // --- internals ----------------------------------------------------------------------------------------------

  #state(): StateRow {
    const row = this.#sql
      .exec<StateRow>(
        `SELECT auto_join, admins_migrated, counter, index_synced FROM membership WHERE id = 1`,
      )
      .toArray()[0];

    if (row === undefined) throw new Error("the membership row is missing");

    return row;
  }

  /** Bumps the counter of changes the registry's index has to catch up with. */
  #removed(principal: string): boolean {
    return (
      this.#count(`SELECT COUNT(*) AS n FROM removed_principals WHERE principal = ?`, principal) > 0
    );
  }

  #tombstone(principal: string): void {
    this.#sql.exec(
      `INSERT OR REPLACE INTO removed_principals (principal, removed_at) VALUES (?, ?)`,
      principal,
      this.#now(),
    );
  }

  #restore(principal: string): void {
    this.#sql.exec(`DELETE FROM removed_principals WHERE principal = ?`, principal);
  }

  #changed(): void {
    this.#sql.exec(`UPDATE membership SET counter = counter + 1 WHERE id = 1`);
  }

  #insertMember(email: string, granted: OrgRole, now: number, by: string): string {
    let id = freshId("mem");

    while (this.#memberById(id) !== undefined) id = freshId("mem");

    this.#sql.exec(
      `INSERT INTO members (id, email, role, added_at, added_by) VALUES (?, ?, ?, ?, ?)`,
      id,
      email,
      granted,
      now,
      by,
    );

    return id;
  }

  #memberById(id: string): MemberRow | undefined {
    return this.#sql
      .exec<MemberRow>(`SELECT id, email, role, added_at FROM members WHERE id = ?`, id)
      .toArray()[0];
  }

  #memberByEmail(email: string): MemberRow | undefined {
    return this.#sql
      .exec<MemberRow>(`SELECT id, email, role, added_at FROM members WHERE email = ?`, email)
      .toArray()[0];
  }

  #memberRecord(row: MemberRow, teams: ReadonlyArray<string>): MemberRecord {
    return { id: row.id, email: row.email, role: role(row.role), addedAt: row.added_at, teams };
  }

  #teamsOf(memberId: string): ReadonlyArray<string> {
    return this.#sql
      .exec<LinkRow>(
        `SELECT team_id, member_id FROM team_members WHERE member_id = ? ORDER BY team_id`,
        memberId,
      )
      .toArray()
      .map((row) => row.team_id);
  }

  #teamsByMember(): ReadonlyMap<string, ReadonlyArray<string>> {
    const byMember = new Map<string, Array<string>>();

    for (const link of this.#sql
      .exec<LinkRow>(`SELECT team_id, member_id FROM team_members ORDER BY team_id`)
      .toArray()) {
      const teams = byMember.get(link.member_id) ?? [];
      teams.push(link.team_id);
      byMember.set(link.member_id, teams);
    }

    return byMember;
  }

  #teamRow(id: string): TeamRow | undefined {
    return this.#sql
      .exec<TeamRow>(`SELECT id, name, created_at FROM teams WHERE id = ?`, id)
      .toArray()[0];
  }

  #teamByName(name: string): TeamRow | undefined {
    return this.#sql
      .exec<TeamRow>(
        `SELECT id, name, created_at FROM teams WHERE name_key = ?`,
        name.toLowerCase(),
      )
      .toArray()[0];
  }

  #token(clientId: string): TokenRow | undefined {
    return this.#sql
      .exec<TokenRow>(
        `SELECT client_id, name, role, added_at FROM service_tokens WHERE client_id = ?`,
        clientId,
      )
      .toArray()[0];
  }

  #tokenRecord(row: TokenRow): ServiceTokenRecord {
    return { clientId: row.client_id, name: row.name, role: role(row.role), addedAt: row.added_at };
  }

  #owners(): number {
    return this.#count(`SELECT COUNT(*) AS n FROM members WHERE role = 'owner'`);
  }

  #count(sql: string, ...bindings: Array<SqlStorageValue>): number {
    return this.#sql.exec<CountRow>(sql, ...bindings).toArray()[0]?.n ?? 0;
  }

  /** The refusal for an actor who may not manage a member holding `target`. */
  #denied(target: OrgRole): MemberRefused {
    return target === "member"
      ? refuse("admin_required", MESSAGES.adminRequired)
      : refuse("owner_required", MESSAGES.ownerRequired);
  }

  #tokenDenied(actor: Actor, target: OrgRole): MemberRefused {
    if (target !== "member")
      return refuse("service_token_owner_required", MESSAGES.tokenOwnerRequired);

    return actor.role === "member"
      ? refuse("admin_required", MESSAGES.adminRequired)
      : refuse("owner_required", MESSAGES.ownerRequired);
  }

  #found(id: string): MemberResult<MemberRecord> {
    const member = this.member(id);

    if (member === undefined) throw new Error("the member just written is missing");

    return ok(member);
  }

  #foundTeam(id: string): MemberResult<TeamRecord> {
    const team = this.team(id);

    if (team === undefined) throw new Error("the team just written is missing");

    return ok(team);
  }

  #foundToken(clientId: string): MemberResult<ServiceTokenRecord> {
    const token = this.#token(clientId);

    if (token === undefined) throw new Error("the service token just written is missing");

    return ok(this.#tokenRecord(token));
  }
}
