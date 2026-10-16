/**
 * The people of Commissary Cloud (ADR 0026, `apps/app/src/management/people-routes.ts`, the Platform registry in
 * `apps/app/src/platform`): a platform admin reads a person's owned-org count and limit, raises the limit, and suspends
 * or unsuspends them. A self-hosted Commissary has no such routes (404). Workers addition, no Go counterpart. Shared
 * with the browser: imports `effect` only.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { managementErrors } from "./errors.ts";

/** A person as platform admins see them; one who never signed in can be looked up (and prepared) too. */
export const PersonView = Schema.Struct({
  email: Schema.String,
  /** ISO time of their first sign-in. */
  signed_up_at: Schema.optionalKey(Schema.String),
  /** How many orgs they may own. */
  org_limit: Schema.Number,
  /** Whether `org_limit` is a platform admin's choice (otherwise the deployment's default). */
  org_limit_set: Schema.Boolean,
  /** How many orgs they created, their Personal org included. */
  owned_orgs: Schema.Number,
  suspended: Schema.Boolean,
});

export type PersonView = typeof PersonView.Type;

/**
 * `PATCH /people/:email`: `org_limit` (0-1000, `null` for the deployment's default) and/or `suspended` (signs them out
 * and refuses their sessions, API keys and management keys until unsuspended).
 */
export const UpdatePerson = Schema.Struct({
  org_limit: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  suspended: Schema.optionalKey(Schema.Boolean),
});

export type UpdatePerson = typeof UpdatePerson.Type;

const emailParam = { params: { email: Schema.String } };

/** Platform admins only (`403 platform_admin_required`); `422 invalid_email` / `invalid_org_limit`. */
export class PeopleGroup extends HttpApiGroup.make("people").add(
  HttpApiEndpoint.get("get", "/people/:email", {
    ...emailParam,
    success: PersonView,
    error: managementErrors,
  }),
  HttpApiEndpoint.patch("update", "/people/:email", {
    ...emailParam,
    payload: UpdatePerson,
    success: PersonView,
    error: managementErrors,
  }),
) {}
