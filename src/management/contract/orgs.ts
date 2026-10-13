/**
 * The orgs of the deployment and what the caller may do with them (`../org-routes.ts`, the Platform registry in
 * `src/platform`): `GET /me` for the panel's org switcher, and the platform admins' org list, creation and rename.
 * Workers addition, no Go counterpart. Shared with the browser: imports `effect` only.
 *
 * `/orgs` and `/orgs/:slug` are platform-level. Every other management route also exists once per org, as
 * `/v8/management/orgs/<slug>/<route>`; the unscoped spelling means the deployment's first org, `global` (ADR 0021).
 * Only platform admins (`PLATFORM_ADMIN_*`) may list, create and rename orgs: anyone else gets
 * `403 platform_admin_required`.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { managementErrors } from "./errors.ts";
import { OrgRole } from "./members.ts";

/** One org of the registry. */
export const OrgView = Schema.Struct({
  /** Permanent; names the org's stored data. */
  id: Schema.String,
  /** Addresses the org in URLs (`/o/<slug>/accounts`); unique, renamable. */
  slug: Schema.String,
  name: Schema.String,
  /** ISO time the org was created. */
  created_at: Schema.String,
});

export type OrgView = typeof OrgView.Type;

export const OrgList = Schema.Struct({ orgs: Schema.Array(OrgView) });

export type OrgList = typeof OrgList.Type;

/** `POST /orgs`: 1-63 lowercase letters, digits and inner hyphens; a display name of up to 100 characters. */
export const CreateOrg = Schema.Struct({ slug: Schema.String, name: Schema.String });

export type CreateOrg = typeof CreateOrg.Type;

/** `PATCH /orgs/:slug`: the fields to change. Renaming the slug breaks the old address; the id stays. */
export const UpdateOrg = Schema.Struct({
  slug: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
});

export type UpdateOrg = typeof UpdateOrg.Type;

/** An org the caller belongs to, as the panel's org switcher lists it. */
export const MyOrg = Schema.Struct({ slug: Schema.String, name: Schema.String });

export type MyOrg = typeof MyOrg.Type;

/**
 * `GET /me`: who the caller is for the panel, which orgs they may open, and their role in the org the request
 * addresses (`/v8/management/orgs/<slug>/me`; `global` for the unscoped spelling).
 */
export const Me = Schema.Struct({
  /** A platform admin is an owner of every org and may create orgs. */
  platform_admin: Schema.Boolean,
  /** The caller's role in the addressed org; `null` when they do not belong to it. */
  role: Schema.NullOr(OrgRole),
  /** Every org for a platform admin; for anyone else the orgs they are a member of. */
  orgs: Schema.Array(MyOrg),
});

export type Me = typeof Me.Type;

const slugParam = { params: { slug: Schema.String } };

export class OrgsGroup extends HttpApiGroup.make("orgs").add(
  /** The caller and the orgs they belong to; anyone Access admits may ask. */
  HttpApiEndpoint.get("me", "/me", { success: Me, error: managementErrors }),
  /** Every org, `global` (slug `default` at first) leading. Platform admins only. */
  HttpApiEndpoint.get("list", "/orgs", { success: OrgList, error: managementErrors }),
  /**
   * Creates an org with an id of its own. Platform admins only. `422 invalid_slug` / `invalid_name`, `409 slug_taken`.
   */
  HttpApiEndpoint.post("create", "/orgs", {
    payload: CreateOrg,
    success: OrgView.pipe(HttpApiSchema.status(201)),
    error: managementErrors,
  }),
  /** Renames an org's name and/or slug. Platform admins only. `404 org_not_found`, plus the errors of `create`. */
  HttpApiEndpoint.patch("update", "/orgs/:slug", {
    ...slugParam,
    payload: UpdateOrg,
    success: OrgView,
    error: managementErrors,
  }),
) {}
