/**
 * The ControlPlane stubs of an org (ADR 0021): an org's state lives in its own ControlPlane Durable Object, named by the
 * org id. The pure org model (`OrgId`, `GLOBAL_ORG`, `CurrentOrg`, org-scoped names) is `@commissary/core`.
 *
 * {@link controlPlaneOf} is the only place that turns an org into a ControlPlane stub.
 */
import { Schema } from "effect";
import { OrgId } from "@commissary/core";

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
