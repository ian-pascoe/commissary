/**
 * Per-org single sign-on on a hosted proxy (issue #76; `../sso-routes.ts`, the ControlPlane's `SsoStore` in
 * `src/sso`): the org's identity provider (one, OIDC or SAML) and the email domains it proves with a DNS TXT record.
 * Workers addition, no Go counterpart. Shared with the browser: imports `effect` only.
 *
 * Org admins read the settings; only an org owner changes them. A self-hosted proxy has no such routes (404): Access
 * configures its identity providers.
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { managementErrors } from "./errors.ts";

/** An OIDC provider as the panel shows it: never its client secret. */
export const OidcProviderView = Schema.Struct({
  kind: Schema.Literal("oidc"),
  issuer: Schema.String,
  client_id: Schema.String,
  /** The endpoints its discovery document named when it was saved. */
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  updated_at: Schema.String,
  updated_by: Schema.String,
});

export const SamlProviderView = Schema.Struct({
  kind: Schema.Literal("saml"),
  entry_point: Schema.String,
  idp_entity_id: Schema.String,
  /** When the signing certificate expires (ISO). */
  certificate_expires_at: Schema.String,
  updated_at: Schema.String,
  updated_by: Schema.String,
});

export const SsoProviderView = Schema.Union([OidcProviderView, SamlProviderView]);

export type SsoProviderView = typeof SsoProviderView.Type;

/** A domain of the org: the TXT record that verifies it, whether it is verified and whether it requires SSO. */
export const SsoDomainView = Schema.Struct({
  domain: Schema.String,
  verified: Schema.Boolean,
  verified_at: Schema.optionalKey(Schema.String),
  require_sso: Schema.Boolean,
  /** Publish `value` as a TXT record at `name`, then verify. */
  record: Schema.Struct({ name: Schema.String, value: Schema.String }),
});

export type SsoDomainView = typeof SsoDomainView.Type;

/** The proxy's side, for the identity provider's settings. */
export const ServiceProviderView = Schema.Struct({
  /** The OIDC redirect URI to register with the provider. */
  oidc_redirect_uri: Schema.String,
  /** SAML: the assertion consumer service URL (HTTP-POST), the proxy's entity id and its metadata. */
  saml_acs_url: Schema.String,
  saml_entity_id: Schema.String,
  saml_metadata_url: Schema.String,
});

/** `GET /sso`. */
export const SsoSettings = Schema.Struct({
  provider: Schema.NullOr(SsoProviderView),
  domains: Schema.Array(SsoDomainView),
  service_provider: ServiceProviderView,
});

export type SsoSettings = typeof SsoSettings.Type;

/** `PUT /sso/provider` for OIDC: the issuer is discovered; an empty secret keeps the stored one. */
export const OidcProviderInput = Schema.Struct({
  kind: Schema.Literal("oidc"),
  issuer: Schema.String,
  client_id: Schema.String,
  client_secret: Schema.optionalKey(Schema.String),
});

export const SamlProviderInput = Schema.Struct({
  kind: Schema.Literal("saml"),
  entry_point: Schema.String,
  idp_entity_id: Schema.String,
  /** PEM or base64 X.509 certificate the provider signs assertions with. */
  certificate: Schema.String,
});

export const SsoProviderInput = Schema.Union([OidcProviderInput, SamlProviderInput]);

export type SsoProviderInput = typeof SsoProviderInput.Type;

/** `POST /sso/provider/test`: what the test found (a failure answers `422` with `message`). */
export const SsoProviderTest = Schema.Struct({ message: Schema.String });

export const AddSsoDomain = Schema.Struct({ domain: Schema.String });

export const UpdateSsoDomain = Schema.Struct({ require_sso: Schema.Boolean });

const domainParam = { params: { domain: Schema.String } };

/** Org admins read; org owners change (`403 owner_required` otherwise). */
export class SsoGroup extends HttpApiGroup.make("sso").add(
  HttpApiEndpoint.get("get", "/sso", { success: SsoSettings, error: managementErrors }),
  /**
   * Sets the identity provider, replacing any other. `422 invalid_provider` / `discovery_failed` with `message`;
   * `422 client_secret_required` for a new OIDC provider without its secret.
   */
  HttpApiEndpoint.put("setProvider", "/sso/provider", {
    payload: SsoProviderInput,
    success: SsoProviderView,
    error: managementErrors,
  }),
  /** `409 sso_required` while a domain requires single sign-on; `404 provider_missing`. */
  HttpApiEndpoint.delete("removeProvider", "/sso/provider", {
    success: SsoProviderView,
    error: managementErrors,
  }),
  /** `422 discovery_failed` / `provider_unreachable` / `invalid_provider` with `message`; `404 provider_missing`. */
  HttpApiEndpoint.post("testProvider", "/sso/provider/test", {
    success: SsoProviderTest,
    error: managementErrors,
  }),
  /** `422 invalid_domain`; `409 domain_exists` / `too_many_domains`. */
  HttpApiEndpoint.post("addDomain", "/sso/domains", {
    payload: AddSsoDomain,
    success: SsoDomainView.pipe(HttpApiSchema.status(201)),
    error: managementErrors,
  }),
  /**
   * Looks the TXT record up: `422 record_not_found`, `503 dns_unavailable`, `409 domain_taken` when another org has
   * verified the domain; `404 domain_not_found`.
   */
  HttpApiEndpoint.post("verifyDomain", "/sso/domains/:domain/verify", {
    ...domainParam,
    success: SsoDomainView,
    error: managementErrors,
  }),
  /** `409 domain_unverified` / `404 provider_missing` when requiring single sign-on is not possible yet. */
  HttpApiEndpoint.patch("updateDomain", "/sso/domains/:domain", {
    ...domainParam,
    payload: UpdateSsoDomain,
    success: SsoDomainView,
    error: managementErrors,
  }),
  HttpApiEndpoint.delete("removeDomain", "/sso/domains/:domain", {
    ...domainParam,
    success: SsoDomainView,
    error: managementErrors,
  }),
) {}
