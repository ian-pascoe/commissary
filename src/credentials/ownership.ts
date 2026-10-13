/**
 * Who owns a credential and who may see or manage it (ADR 0023, ADR 0025).
 *
 * A credential belongs to the org (a shared credential: `owner` unset) or to one member (a private credential:
 * `owner` is that member's id). Selection offers a private credential only to requests of its owner; management
 * gives the owner full control, lets an org admin see that it exists (provider, owner, label) and disable or remove
 * it, and shows nobody else anything. A shared credential is for org admins only, as before.
 */

/** Who asks: the member of the request (none for a service token) and whether they are an org admin. */
export interface Viewer {
  readonly member?: string | undefined;
  readonly admin: boolean;
}

/**
 * - `full`: every management operation;
 * - `limited`: an org admin on a private credential: listed without details, may disable or remove it;
 * - `none`: the credential does not exist for this viewer.
 */
export type Access = "full" | "limited" | "none";

export const isPrivate = (credential: { readonly owner?: string | undefined }): boolean =>
  credential.owner !== undefined;

/** The viewer's access to a credential owned by `owner` (undefined: shared). */
export const accessTo = (owner: string | undefined, viewer: Viewer): Access => {
  if (owner === undefined) return viewer.admin ? "full" : "none";

  if (viewer.member !== undefined && viewer.member === owner) return "full";

  return viewer.admin ? "limited" : "none";
};

/** Whether a request of `member` may be served by a credential owned by `owner` (selection). */
export const servesMember = (
  credential: { readonly owner?: string | undefined },
  member: string | undefined,
): boolean => credential.owner === undefined || credential.owner === member;
