/**
 * Management keys (ADR 0026; `apps/app/src/management/management-key-routes.ts`, the ControlPlane's
 * `ManagementKeyStore` in `apps/app/src/management-keys`): keys scripts send on the management API, on every
 * deployment. Workers addition, no Go counterpart. Shared with the browser: imports `effect` only.
 *
 * Org admins issue, list and revoke them. A key holds a role in its org (at most the issuer's role), is stored hashed,
 * is shown whole once (in the answer to its creation) and names its org like an API key: `cmsm_<orgId>_<keyId>_<secret>`,
 * sent as `Authorization: Bearer cmsm_…`. It is accepted on the management API only, never on the client API, and it
 * can never download a stored credential, register a service token, change a service token's role or issue a key.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { managementErrors } from "./errors.ts";
import { OrgRole } from "./members.ts";

/** A key as lists show it: never the key itself. Times are ISO. */
export const ManagementKeyView = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  role: OrgRole,
  /** `cmsm_<orgId>_<keyId>_<first 4 secret characters>`, so its issuer recognises it. */
  prefix: Schema.String,
  /** Who issued it: an email, or `service:<client id>` for a service token. */
  created_by: Schema.String,
  created_at: Schema.String,
  /** When it was last accepted (updated at most once a minute); absent when never used. */
  last_used_at: Schema.optionalKey(Schema.String),
});

export type ManagementKeyView = typeof ManagementKeyView.Type;

export const ManagementKeyList = Schema.Struct({ keys: Schema.Array(ManagementKeyView) });

export type ManagementKeyList = typeof ManagementKeyList.Type;

/** `POST /management-keys`: a name (1-100 characters) and a role no higher than the issuer's. */
export const CreateManagementKey = Schema.Struct({ name: Schema.String, role: OrgRole });

export type CreateManagementKey = typeof CreateManagementKey.Type;

/** The answer to a creation: the new key's entry plus the whole key, shown this once. */
export const CreatedManagementKey = Schema.Struct({
  ...ManagementKeyView.fields,
  key: Schema.String,
});

export type CreatedManagementKey = typeof CreatedManagementKey.Type;

const idParam = { params: { id: Schema.String } };

/** Org admins only (`403 Forbidden` from the gate otherwise). */
export class ManagementKeysGroup extends HttpApiGroup.make("managementKeys").add(
  HttpApiEndpoint.get("list", "/management-keys", {
    success: ManagementKeyList,
    error: managementErrors,
  }),
  /**
   * `422 invalid_name`; `403 role_too_high` for a role above the issuer's; `403 management_key_forbidden` when the
   * caller is itself a management key; `409 too_many_keys`.
   */
  HttpApiEndpoint.post("create", "/management-keys", {
    payload: CreateManagementKey,
    success: CreatedManagementKey.pipe(HttpApiSchema.status(201)),
    error: managementErrors,
  }),
  /** Refused from the next request on (other isolates within 30 seconds); `404 management_key_not_found`. */
  HttpApiEndpoint.delete("revoke", "/management-keys/:id", {
    ...idParam,
    success: ManagementKeyView,
    error: managementErrors,
  }),
) {}
