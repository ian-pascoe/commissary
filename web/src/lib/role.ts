// What the caller's role in the org lets the panel show (ADR 0022). The server enforces every rule again; these
// functions keep the panel from offering a control that would be refused. Pure: no DOM, tested in
// test/web-role.test.ts.
//
// Roles: org owner > org admin > member. A plain member may only read their own usage, manage their own proxy keys
// and, where the org lets members connect private credentials (ADR 0023), manage their own private accounts and API
// keys; org admins manage the org's configuration, plain members and teams, and see every proxy key; org owners also
// change roles, add org admins and org owners, and decide who may join by themselves. A platform admin is an org owner
// of every org.
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
  owner: "Org owner",
  admin: "Org admin",
  member: "Member",
};

export const roleLabel = (role: OrgRole): string => LABELS[role];

/** A role in a sentence: "an org owner", "an org admin", "a member". */
export const roleAs = (role: OrgRole): string =>
  role === "member" ? "a member" : `an ${roleLabel(role).toLowerCase()}`;

/** What a role may do, in a sentence (hints under role pickers). */
export const roleSummary = (role: OrgRole): string => {
  switch (role) {
    case "owner":
      return "Everything an org admin can do, plus changing roles and who may join.";
    case "admin":
      return "Manages accounts, keys, models, settings, plain members and teams.";
    case "member":
      return "Sees their own usage and limits, and manages their own proxy keys.";
  }
};

/**
 * The caller's role in the org the panel shows, from the org-scoped `GET /me`. A platform admin is an org owner of every
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
  /** A plain member opens it too where the org lets members connect private credentials (their own rows only). */
  readonly privateMembers?: boolean;
}

/** The pages of the shell's nav, in order. A plain member's panel is the Usage page. */
export const PAGES: ReadonlyArray<PanelPage> = [
  { to: "/", label: "Overview", role: "admin" },
  { to: "/accounts", label: "Accounts", role: "admin", privateMembers: true },
  { to: "/keys", label: "API keys", role: "admin", privateMembers: true },
  { to: "/models", label: "Models", role: "admin" },
  { to: "/usage", label: "Usage", role: "member" },
  { to: "/my-models", label: "My models", role: "member" },
  { to: "/proxy-keys", label: "Proxy keys", role: "member" },
  { to: "/limits", label: "Limits", role: "member" },
  { to: "/management-keys", label: "Management keys", role: "admin" },
  { to: "/members", label: "Members", role: "admin" },
  { to: "/grants", label: "Grants", role: "admin" },
  { to: "/settings", label: "Settings", role: "admin" },
];

/** The nav links a role sees; `privateCredentials`: the org lets members connect private credentials. */
export const pagesFor = (role: OrgRole, privateCredentials = false): ReadonlyArray<PanelPage> =>
  PAGES.filter(
    (page) => atLeast(role, page.role) || (privateCredentials && page.privateMembers === true),
  );

/** The page a role lands on when the one asked for is not theirs: the Overview for org admins, Usage for the rest. */
export const homeFor = (role: OrgRole): string => (atLeast(role, "admin") ? "/" : "/usage");

const trimmed = (pathname: string): string =>
  pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;

const within = (pathname: string, page: string): boolean =>
  trimmed(pathname) === page || pathname.startsWith(`${page}/`);

/**
 * Whether a role may open a page of the panel (`pathname` is relative to the org's base path). Sub-pages of a page
 * need an org admin, like `/usage/prices`, except the page itself. A plain member opens Usage, My models, Proxy keys and Limits, and the
 * pages of their own private accounts and API keys, with their sub-pages, where the org lets members connect private
 * credentials.
 */
export const pageAllowed = (role: OrgRole, pathname: string, privateCredentials = false): boolean =>
  atLeast(role, "admin") ||
  trimmed(pathname) === "/usage" ||
  trimmed(pathname) === "/my-models" ||
  trimmed(pathname) === "/proxy-keys" ||
  trimmed(pathname) === "/limits" ||
  (privateCredentials && (within(pathname, "/accounts") || within(pathname, "/keys")));

// ---------------------------------------------------------------------------------------------------------------
// Members and teams

/** Who the caller is when they act: their role in the org and whether they are a platform admin. */
export interface Caller {
  readonly role: OrgRole;
  readonly platformAdmin: boolean;
  /** The org lets members connect private credentials (ADR 0023). */
  readonly privateCredentials: boolean;
}

export const callerOf = (
  me: Pick<Me, "role" | "platform_admin"> & { readonly private_credentials?: boolean | undefined },
): Caller => ({
  role: effectiveRole(me),
  platformAdmin: me.platform_admin,
  privateCredentials: me.private_credentials === true,
});

/** Whether the caller connects their own private credentials: a plain member (where allowed) holds nothing else. */
export const holdsOnlyPrivate = (caller: Caller): boolean => !atLeast(caller.role, "admin");

/** Org admins manage plain members and teams; org owners everyone. */
export const canManageMembers = (caller: Caller): boolean => atLeast(caller.role, "admin");

/** The roles the caller may give a person they add: org admins add plain members, org owners any role. */
export const addableRoles = (caller: Caller): ReadonlyArray<OrgRole> =>
  ROLES.filter((role) => atLeast(caller.role, role === "member" ? "admin" : "owner"));

/** Changing a member's role (or a token's) is for org owners. */
export const canChangeRoles = (caller: Caller): boolean => atLeast(caller.role, "owner");

/** Removing a plain member is for org admins; removing an org admin or an org owner for org owners. */
export const canRemove = (caller: Caller, target: OrgRole): boolean =>
  atLeast(caller.role, target === "member" ? "admin" : "owner");

/** Whether people Access admits may join by themselves is decided by org owners. */
export const canSetAutoJoin = (caller: Caller): boolean => atLeast(caller.role, "owner");

/** Whether the proxy routes still accept an Access sign-in instead of a proxy key is decided by org owners too. */
export const canSetAccessClients = canSetAutoJoin;

/** Org admins list and revoke every proxy key of the org; every member their own. */
export const seesEveryProxyKey = (caller: Caller): boolean => atLeast(caller.role, "admin");

/** Org admins set any Spend limit and the calendar; a plain member limits their own proxy keys. */
export const setsAnyLimit = (caller: Caller): boolean => atLeast(caller.role, "admin");

export const canManageTeams = (caller: Caller): boolean => atLeast(caller.role, "admin");

/**
 * The roles the caller may register a service token with. A role above member needs a service token that is an org
 * org owner or a platform admin: a person who is only an org owner, however powerful, registers member tokens. A platform
 * admin may register any role.
 */
export const tokenRoles = (caller: Caller): ReadonlyArray<OrgRole> => {
  if (!atLeast(caller.role, "admin")) return [];

  return caller.platformAdmin ? ROLES : ["member"];
};

/**
 * The roles the caller may change a registered token to: org owners only, and to what `tokenRoles` offers (an org owner who
 * is no platform admin may only demote a token to member).
 */
export const tokenRoleChanges = (caller: Caller, current: OrgRole): ReadonlyArray<OrgRole> =>
  canChangeRoles(caller) ? tokenRoles(caller).filter((role) => role !== current) : [];

/** Removing a token takes its rights away: org admins remove plain member tokens, org owners any. */
export const canRemoveToken = canRemove;
