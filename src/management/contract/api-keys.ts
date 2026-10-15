/**
 * API keys (ADR 0022; `../api-key-routes.ts`, the ControlPlane's `ApiKeyStore` in `src/api-keys`): the keys
 * clients send on the client API instead of an Access sign-in. Workers addition, no Go counterpart. Shared with the
 * browser: imports `effect` only.
 *
 * Every member creates, lists and revokes their own keys; org admins list and revoke every key in the org. A key is
 * shown whole once, in the answer to its creation; lists show its prefix only.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { managementErrors } from "./errors.ts";

/** A key as lists show it: never the key itself. Times are ISO. */
export const ApiKeyView = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** `cms_<orgId>_<keyId>_<first 4 secret characters>`, so its member recognises it. */
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

export type ApiKeyView = typeof ApiKeyView.Type;

/** `GET /api-keys`: the caller's keys, or every key of the org for an org admin; newest first. */
export const ApiKeyList = Schema.Struct({ keys: Schema.Array(ApiKeyView) });

export type ApiKeyList = typeof ApiKeyList.Type;

/** `POST /api-keys`: a name (1-100 characters) and an optional ISO expiry in the future. */
export const CreateApiKey = Schema.Struct({
  name: Schema.String,
  expires_at: Schema.optionalKey(Schema.String),
});

export type CreateApiKey = typeof CreateApiKey.Type;

/** The answer to a creation: the new key's entry plus the whole key, shown this once. */
export const CreatedApiKey = Schema.Struct({
  ...ApiKeyView.fields,
  key: Schema.String,
});

export type CreatedApiKey = typeof CreatedApiKey.Type;

const idParam = { params: { id: Schema.String } };

export class ApiKeysGroup extends HttpApiGroup.make("apiKeys").add(
  HttpApiEndpoint.get("list", "/api-keys", { success: ApiKeyList, error: managementErrors }),
  /**
   * `422 invalid_name`, `422 invalid_expiry`, `409 too_many_keys`; `403 member_required` for a caller who is not a
   * member of the org (a service token, a platform admin from outside the org).
   */
  HttpApiEndpoint.post("create", "/api-keys", {
    payload: CreateApiKey,
    success: CreatedApiKey.pipe(HttpApiSchema.status(201)),
    error: managementErrors,
  }),
  /** Refused from the next request on; `404 api_key_not_found` for another member's key unless an org admin asks. */
  HttpApiEndpoint.delete("revoke", "/api-keys/:id", {
    ...idParam,
    success: ApiKeyView,
    error: managementErrors,
  }),
) {}
