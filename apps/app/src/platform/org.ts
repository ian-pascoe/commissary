/**
 * The org boundary (ADR 0021): every request and every scheduled job belongs to one org, and an org's state lives in
 * its own ControlPlane Durable Object, named by the org id. New in the Workers port.
 *
 * The existing deployment is the org `global`, the name its ControlPlane already had, so upgrading moves no data. For
 * `global` every derived name (KV keys, SessionState addresses, caller scopes, `auth_index` keys, OAuth states) stays
 * what it was before orgs existed; other orgs get names of their own ({@link orgScopedName}).
 *
 * {@link controlPlaneOf} is the only place that turns an org into a ControlPlane stub.
 */
import { Context, Schema } from "effect";

/**
 * An org id: 1-63 lowercase letters, digits and inner hyphens. The shape is safe in Durable Object names, KV keys,
 * URL paths and OAuth states, and never contains the `.` that separates it from the rest of a scoped name.
 */
export const OrgId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
).pipe(Schema.brand("OrgId"));

export type OrgId = typeof OrgId.Type;

/** A fresh permanent org id. Never derived from the slug: a renamed org's old slug may be taken again. */
export const newOrgId = (): OrgId =>
  OrgId.make(`org-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`);

/** The org of the deployment that existed before orgs: its ControlPlane has always been named `global`. */
export const GLOBAL_ORG: OrgId = OrgId.make("global");

/**
 * An org slug: what addresses the org in URLs (`/o/<slug>/accounts`, `/v9/management/orgs/<slug>/...`). The same
 * characters as an {@link OrgId}, but a slug can be renamed while the id, which names the org's Durable Objects and
 * stored data, never changes.
 */
export const OrgSlug = Schema.String.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
).pipe(Schema.brand("OrgSlug"));

export type OrgSlug = typeof OrgSlug.Type;

/** The slug the Platform registry gives the org `global` when it first starts; a platform admin can rename it. */
export const DEFAULT_ORG_SLUG: OrgSlug = OrgSlug.make("default");

/** The org of the current request or scheduled job. */
export class CurrentOrg extends Context.Service<CurrentOrg, OrgId>()(
  "commissary/platform/CurrentOrg",
) {}

/**
 * The ControlPlane of `org`: its Durable Object is named by the org id. The stub has the type of the caller's view of
 * `CONTROL_PLANE` (`StateEnv`, `ModelsEnv`).
 */
export const controlPlaneOf = <T extends Rpc.DurableObjectBranded>(
  env: { readonly CONTROL_PLANE: DurableObjectNamespace<T> },
  org: OrgId,
): DurableObjectStub<T> => env.CONTROL_PLANE.getByName(org);

/**
 * The org a ControlPlane serves, from its Durable Object id. Every ControlPlane is reached by name
 * ({@link controlPlaneOf}), so an object without an org id as its name is a bug: it throws rather than serving `global`
 * (whose keys and deployment settings another org must never get).
 */
export const orgOfControlPlane = (id: DurableObjectId): OrgId => {
  if (id.name !== undefined && Schema.is(OrgId)(id.name)) return id.name;

  throw new Error(`ControlPlane ${id.toString()} is not named by an org id`);
};

/**
 * `name` within `org`: unchanged for `global`, so the names stored before orgs existed stay valid, and
 * `org.<org>.<name>` for any other org. No unscoped name of `global` starts with `org.`.
 */
export const orgScopedName = (org: OrgId, name: string): string =>
  org === GLOBAL_ORG ? name : `org.${org}.${name}`;

/**
 * The org of a name built by {@link orgScopedName}: `global` for an unscoped name, `undefined` when the name starts
 * like a scoped one (`org.`) but does not carry a valid org id.
 */
export const orgOfScopedName = (name: string): OrgId | undefined => {
  if (!name.startsWith("org.")) return GLOBAL_ORG;
  const end = name.indexOf(".", 4);
  const org = end < 0 ? "" : name.slice(4, end);

  return Schema.is(OrgId)(org) && org !== GLOBAL_ORG ? org : undefined;
};
