/**
 * Proxy keys (ADR 0022; `../proxy-key-routes.ts`, the ControlPlane's `ProxyKeyStore` in `src/proxy-keys`): the keys
 * clients send on the proxy routes instead of an Access sign-in. Workers addition, no Go counterpart. Shared with the
 * browser: imports `effect` only.
 *
 * Every member creates, lists and revokes their own keys; org admins list and revoke every key in the org. A key is
 * shown whole once, in the answer to its creation; lists show its prefix only.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { managementErrors } from "./errors.ts";

/** A key as lists show it: never the key itself. Times are ISO. */
export const ProxyKeyView = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** `cfp_<orgId>_<keyId>_<first 4 secret characters>`, so its member recognises it. */
  prefix: Schema.String,
  member_id: Schema.String,
  /** The email of the member it belongs to. */
  member_email: Schema.optionalKey(Schema.String),
  /** Whether it belongs to the caller. */
  mine: Schema.Boolean,
  created_at: Schema.String,
  last_used_at: Schema.optionalKey(Schema.String),
  expires_at: Schema.optionalKey(Schema.String),
  revoked_at: Schema.optionalKey(Schema.String),
});

export type ProxyKeyView = typeof ProxyKeyView.Type;

/** `GET /proxy-keys`: the caller's keys, or every key of the org for an org admin; newest first. */
export const ProxyKeyList = Schema.Struct({ keys: Schema.Array(ProxyKeyView) });

export type ProxyKeyList = typeof ProxyKeyList.Type;

/** `POST /proxy-keys`: a name (1-100 characters) and an optional ISO expiry in the future. */
export const CreateProxyKey = Schema.Struct({
  name: Schema.String,
  expires_at: Schema.optionalKey(Schema.String),
});

export type CreateProxyKey = typeof CreateProxyKey.Type;

/** The answer to a creation: the new key's entry plus the whole key, shown this once. */
export const CreatedProxyKey = Schema.Struct({
  ...ProxyKeyView.fields,
  key: Schema.String,
});

export type CreatedProxyKey = typeof CreatedProxyKey.Type;

const idParam = { params: { id: Schema.String } };

export class ProxyKeysGroup extends HttpApiGroup.make("proxyKeys").add(
  HttpApiEndpoint.get("list", "/proxy-keys", { success: ProxyKeyList, error: managementErrors }),
  /**
   * `422 invalid_name`, `422 invalid_expiry`, `409 too_many_keys`; `403 member_required` for a caller who is not a
   * member of the org (a service token, a platform admin from outside the org).
   */
  HttpApiEndpoint.post("create", "/proxy-keys", {
    payload: CreateProxyKey,
    success: CreatedProxyKey.pipe(HttpApiSchema.status(201)),
    error: managementErrors,
  }),
  /** Refused from the next request on; `404 proxy_key_not_found` for another member's key unless an org admin asks. */
  HttpApiEndpoint.delete("revoke", "/proxy-keys/:id", {
    ...idParam,
    success: ProxyKeyView,
    error: managementErrors,
  }),
) {}
