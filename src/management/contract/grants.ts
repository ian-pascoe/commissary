/**
 * Grants (`/v9/management/grants`, `../grant-routes.ts`): which upstream models of which shared credentials a member, a
 * team or everyone may use (ADR 0023), and `GET /models/mine`, the models the caller may use. Shared with the browser:
 * imports `effect` and `./config.ts`, `./errors.ts` only.
 *
 * A grant names a subject, a scope and model patterns (`claude-sonnet-*`, case-insensitive, like model exclusions). A
 * member may use the union of the grants that name them; there is no deny. Each grant is a config entry with a revision
 * (ADR 0025): an edit names the revision it was based on in `If-Match` (0 for a new grant). The routes are for org
 * admins; `models/mine` is for every member.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { Revision } from "./config.ts";
import { managementErrors } from "./errors.ts";

/** Who a grant is for: every member (and requests without a member), one member, or one team. */
export const GrantSubject = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("everyone") }),
  Schema.Struct({ kind: Schema.Literal("member"), id: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("team"), id: Schema.String }),
]);

export type GrantSubject = typeof GrantSubject.Type;

/** Which shared credentials a grant covers: all of them, every one of a provider, or one. */
export const GrantScope = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("all") }),
  /** The executor key of the credentials (`claude`, `codex`, `openai-compatible-<name>`, ...). */
  Schema.Struct({ kind: Schema.Literal("provider"), provider: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("credential"), id: Schema.String }),
]);

export type GrantScope = typeof GrantScope.Type;

/** What a grant says; `models` has at least one pattern (`*` is every model). */
export const GrantBody = Schema.Struct({
  subject: GrantSubject,
  scope: GrantScope,
  models: Schema.Array(Schema.String),
});

export type GrantBody = typeof GrantBody.Type;

export const Grant = Schema.Struct({
  ...GrantBody.fields,
  id: Schema.String,
  revision: Revision,
  /** Epoch milliseconds. */
  updated_at: Schema.Number,
  /** The principal that wrote it. */
  updated_by: Schema.String,
});

export type Grant = typeof Grant.Type;

/** `version` is the counter of grant writes and team changes the list was read at. */
export const Grants = Schema.Struct({
  version: Schema.Int,
  grants: Schema.Array(Grant),
});

export type Grants = typeof Grants.Type;

/** A saved grant: its `id` and new `revision` (0 when it was removed). */
export const GrantSaved = Schema.Struct({
  status: Schema.Literal("ok"),
  version: Schema.Int,
  id: Schema.String,
  revision: Revision,
});

export type GrantSaved = typeof GrantSaved.Type;

/** A model the caller may use (the registry as their grants leave it). */
export const MyModel = Schema.Struct({
  id: Schema.String,
  display_name: Schema.optionalKey(Schema.String),
  owned_by: Schema.String,
  type: Schema.String,
});

export type MyModel = typeof MyModel.Type;

/** `GET /models/mine`: the models the caller may use, ids sorted. */
export const MyModels = Schema.Struct({ models: Schema.Array(MyModel) });

export type MyModels = typeof MyModels.Type;

/** The `If-Match` request header: the grant's revision the edit was based on (a bare number or `"<number>"`). */
const IfMatch = { headers: Schema.Struct({ "if-match": Schema.String }) };

const idParam = { params: { id: Schema.String } };

export class GrantsGroup extends HttpApiGroup.make("grants").add(
  HttpApiEndpoint.get("list", "/grants", { success: Grants, error: managementErrors }),
  /** Add a grant (409 when the subject and scope have one: edit that one). */
  HttpApiEndpoint.post("create", "/grants", {
    payload: GrantBody,
    success: GrantSaved,
    error: managementErrors,
  }),
  /** Replace a grant's subject, scope and models. */
  HttpApiEndpoint.put("replace", "/grants/:id", {
    ...idParam,
    ...IfMatch,
    payload: GrantBody,
    success: GrantSaved,
    error: managementErrors,
  }),
  /** Remove a grant: its members lose what only it gave them. */
  HttpApiEndpoint.delete("remove", "/grants/:id", {
    ...idParam,
    ...IfMatch,
    success: GrantSaved,
    error: managementErrors,
  }),
  /** The models the caller may use. */
  HttpApiEndpoint.get("mine", "/models/mine", { success: MyModels, error: managementErrors }),
) {}
