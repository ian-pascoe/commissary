/**
 * Org roles (ADR 0022) and the rules of who may grant them. New in the Workers port, no Go counterpart.
 *
 * A member holds one role in their org: org owner, org admin or plain member. Org owners are org admins too. A
 * platform admin (`PLATFORM_ADMIN_*`) holds owner rights in every org without being stored anywhere. Pure functions
 * only: the Access gate (`access/authenticate.ts`), the management routes and the ControlPlane's `MemberStore` share
 * them, so the matrix in `docs/ACCESS.md` has one implementation.
 */
import { Schema } from "effect";
import { OrgRole } from "@commissary/contract/members";

export { OrgRole };

export const isOrgRole = Schema.is(OrgRole);

const RANK: Readonly<Record<OrgRole, number>> = { member: 0, admin: 1, owner: 2 };

/** Whether `role` includes the rights of `minimum` (an owner is an admin and a member too). */
export const roleAtLeast = (role: OrgRole | undefined, minimum: OrgRole): boolean =>
  role !== undefined && RANK[role] >= RANK[minimum];

/** Who acts, as the rules below need it. */
export interface Actor {
  /** The actor's role in the org: `owner` for a platform admin. */
  readonly role: OrgRole;
  /** Whether the actor holds the sensitive powers ({@link holdsSensitivePowers}). */
  readonly sensitive: boolean;
}

/**
 * ADR 0006's rule per org (ADR 0022): downloading a stored credential and giving a service token a role above plain
 * member need a service token that holds the owner role in the org, or a platform admin. A person's browser session is
 * the most exposed way in and must not be able to grant itself those powers.
 */
export const holdsSensitivePowers = (identity: {
  readonly platformAdmin: boolean;
  readonly principal: { readonly kind: "user" | "service" | "key" | "mkey" };
  readonly role?: OrgRole | undefined;
}): boolean =>
  identity.platformAdmin || (identity.principal.kind === "service" && identity.role === "owner");

/**
 * Whether `actor` may add or remove a member who holds (or would hold) `role`: org admins manage plain members, org
 * owners manage everyone.
 */
export const mayManageMember = (actor: Actor, role: OrgRole): boolean =>
  roleAtLeast(actor.role, role === "member" ? "admin" : "owner");

/** Changing the role of an existing member is for org owners. */
export const mayChangeRoles = (actor: Actor): boolean => roleAtLeast(actor.role, "owner");

/**
 * Whether `actor` may register a service token with `role`, or change a registered token to it: a plain member token
 * needs an org admin (an org owner to change an existing token's role), anything above needs the sensitive powers.
 */
export const mayGrantTokenRole = (actor: Actor, role: OrgRole, change: boolean): boolean =>
  role === "member"
    ? roleAtLeast(actor.role, change ? "owner" : "admin")
    : actor.sensitive && roleAtLeast(actor.role, "owner");

/** Removing a service token takes away its rights: org admins remove plain member tokens, org owners any. */
export const mayRemoveToken = (actor: Actor, role: OrgRole): boolean =>
  mayManageMember(actor, role);
