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

/** The org of the deployment that existed before orgs: its ControlPlane has always been named `global`. */
export const GLOBAL_ORG: OrgId = OrgId.make("global");

/**
 * The orgs scheduled work runs for. Only `global` until the Platform registry lists the deployment's orgs.
 */
export const DEPLOYMENT_ORGS: ReadonlyArray<OrgId> = [GLOBAL_ORG];

/** The org of the current request or scheduled job. */
export class CurrentOrg extends Context.Service<CurrentOrg, OrgId>()(
  "cf-llm-proxy/platform/CurrentOrg",
) {}

export type ControlPlaneStub = ReturnType<Env["CONTROL_PLANE"]["getByName"]>;

/** The ControlPlane of `org`: its Durable Object is named by the org id. */
export const controlPlaneOf = (env: Env, org: OrgId): ControlPlaneStub =>
  env.CONTROL_PLANE.getByName(org);

/**
 * The org a ControlPlane serves, from its Durable Object id. Every ControlPlane is reached by name
 * ({@link controlPlaneOf}); an object whose name is not an org id (only tests create those) serves `global`.
 */
export const orgOfControlPlane = (id: DurableObjectId): OrgId =>
  id.name !== undefined && Schema.is(OrgId)(id.name) ? id.name : GLOBAL_ORG;

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
