// What the caller's role in the org lets the panel show (ADR 0022). The server enforces every rule again; these
// functions keep the panel from offering a control that would be refused. Pure: no DOM, tested in
// test/web-role.test.ts.
//
// Roles: owner > admin > member. A plain member may only read their own usage; admins manage the org's configuration,
// plain members and teams; owners also change roles, add admins and owners, and decide who may join by themselves. A
// platform admin is an owner of every org.
import type { Me } from "#contract/orgs.ts";
import type { OrgRole } from "#contract/members.ts";

export type { OrgRole };

/** Roles from least to most powerful. */
export const ROLES: ReadonlyArray<OrgRole> = ["member", "admin", "owner"];

/** The role a picker's value names, if it names one. */
export const roleOf = (value: string): OrgRole | undefined => ROLES.find((role) => role === value);

const RANK: Readonly<Record<OrgRole, number>> = { member: 0, admin: 1, owner: 2 };

/** Whether `role` includes the rights of `minimum`. */
export const atLeast = (role: OrgRole, minimum: OrgRole): boolean => RANK[role] >= RANK[minimum];

const LABELS: Readonly<Record<OrgRole, string>> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

export const roleLabel = (role: OrgRole): string => LABELS[role];

/** A role in a sentence: "an owner", "an admin", "a member". */
export const roleAs = (role: OrgRole): string => (role === "member" ? "a member" : `an ${role}`);

/** What a role may do, in a sentence (hints under role pickers). */
export const roleSummary = (role: OrgRole): string => {
  switch (role) {
    case "owner":
      return "Everything an admin can do, plus changing roles and who may join.";
    case "admin":
      return "Manages accounts, keys, models, settings, plain members and teams.";
    case "member":
      return "Sees their own usage and nothing else.";
  }
};

/**
 * The caller's role in the org the panel shows, from the org-scoped `GET /me`. A platform admin is an owner of every
 * org; someone with no role in the org is treated as a plain member (the least they could be).
 */
export const effectiveRole = (me: Pick<Me, "role" | "platform_admin">): OrgRole =>
  me.role ?? (me.platform_admin ? "owner" : "member");

// ---------------------------------------------------------------------------------------------------------------
// Pages

export interface PanelPage {
  readonly to: string;
  readonly label: string;
  /** The least role that opens the page. */
  readonly role: OrgRole;
}

/** The pages of the shell's nav, in order. A plain member's panel is the Usage page. */
export const PAGES: ReadonlyArray<PanelPage> = [
  { to: "/", label: "Overview", role: "admin" },
  { to: "/accounts", label: "Accounts", role: "admin" },
  { to: "/keys", label: "API keys", role: "admin" },
  { to: "/models", label: "Models", role: "admin" },
  { to: "/usage", label: "Usage", role: "member" },
  { to: "/members", label: "Members", role: "admin" },
  { to: "/settings", label: "Settings", role: "admin" },
];

/** The nav links a role sees. */
export const pagesFor = (role: OrgRole): ReadonlyArray<PanelPage> =>
  PAGES.filter((page) => atLeast(role, page.role));

/** The page a role lands on when the one asked for is not theirs: the first page of their nav. */
export const homeFor = (role: OrgRole): string => pagesFor(role)[0]?.to ?? "/usage";

const trimmed = (pathname: string): string =>
  pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;

/**
 * Whether a role may open a page of the panel (`pathname` is relative to the org's base path). Sub-pages of a page
 * need an admin, like `/usage/prices`, except the page itself.
 */
export const pageAllowed = (role: OrgRole, pathname: string): boolean =>
  atLeast(role, "admin") || trimmed(pathname) === "/usage";

// ---------------------------------------------------------------------------------------------------------------
// Members and teams

/** Who the caller is when they act: their role in the org and whether they are a platform admin. */
export interface Caller {
  readonly role: OrgRole;
  readonly platformAdmin: boolean;
}

export const callerOf = (me: Pick<Me, "role" | "platform_admin">): Caller => ({
  role: effectiveRole(me),
  platformAdmin: me.platform_admin,
});

/** Admins manage plain members and teams; owners everyone. */
export const canManageMembers = (caller: Caller): boolean => atLeast(caller.role, "admin");

/** The roles the caller may give a person they add: admins add plain members, owners any role. */
export const addableRoles = (caller: Caller): ReadonlyArray<OrgRole> =>
  ROLES.filter((role) => atLeast(caller.role, role === "member" ? "admin" : "owner"));

/** Changing a member's role (or a token's) is for owners. */
export const canChangeRoles = (caller: Caller): boolean => atLeast(caller.role, "owner");

/** Removing a plain member is for admins; removing an admin or an owner for owners. */
export const canRemove = (caller: Caller, target: OrgRole): boolean =>
  atLeast(caller.role, target === "member" ? "admin" : "owner");

/** Whether people Access admits may join by themselves is decided by owners. */
export const canSetAutoJoin = (caller: Caller): boolean => atLeast(caller.role, "owner");

export const canManageTeams = (caller: Caller): boolean => atLeast(caller.role, "admin");

/**
 * The roles the caller may register a service token with. A role above member needs a service token that is an org
 * owner or a platform admin: a person who is only an org owner, however powerful, registers member tokens. A platform
 * admin may register any role.
 */
export const tokenRoles = (caller: Caller): ReadonlyArray<OrgRole> => {
  if (!atLeast(caller.role, "admin")) return [];

  return caller.platformAdmin ? ROLES : ["member"];
};

/**
 * The roles the caller may change a registered token to: owners only, and to what `tokenRoles` offers (an owner who
 * is no platform admin may only demote a token to member).
 */
export const tokenRoleChanges = (caller: Caller, current: OrgRole): ReadonlyArray<OrgRole> =>
  canChangeRoles(caller) ? tokenRoles(caller).filter((role) => role !== current) : [];

/** Removing a token takes its rights away: admins remove plain member tokens, owners any. */
export const canRemoveToken = canRemove;
