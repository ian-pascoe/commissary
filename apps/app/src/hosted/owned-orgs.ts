/**
 * How many orgs a person of Commissary Cloud may own (ADR 0026): the deployment's default (`OWNED_ORG_LIMIT`), which a
 * platform admin may raise for one person (`management/people-routes.ts`). Checked when an org is created
 * (`management/org-routes.ts`). New in the Workers port.
 */

/** The owned-org limit when the deployment sets none (`OWNED_ORG_LIMIT`). */
export const DEFAULT_OWNED_ORG_LIMIT = 3;

/** The deployment's owned-org limit: `OWNED_ORG_LIMIT` when it is a whole number from 0, the default otherwise. */
export const ownedOrgLimit = (env: { readonly OWNED_ORG_LIMIT?: string | undefined }): number => {
  const value = Number((env.OWNED_ORG_LIMIT ?? "").trim());

  return (env.OWNED_ORG_LIMIT ?? "").trim() !== "" && Number.isSafeInteger(value) && value >= 0
    ? value
    : DEFAULT_OWNED_ORG_LIMIT;
};
