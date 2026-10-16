/**
 * An org's identity provider settings (issue #76): what the org's ControlPlane stores (`@commissary/state`
 * `sso/store.ts`, sealed) and what a sign-in builds Better Auth's provider from (`provider.ts`). New in the Workers
 * port.
 */

/** An OpenID Connect provider: its issuer, Commissary's client there, and the endpoints its discovery document named. */
export interface OidcSettings {
  readonly kind: "oidc";
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksEndpoint: string;
  readonly userInfoEndpoint?: string;
  /** How the client authenticates at the token endpoint; HTTP Basic unless the issuer supports only the form post. */
  readonly tokenEndpointAuthentication?: "client_secret_post";
}

/** A SAML 2.0 identity provider: where to send people, its entity id, and the certificate it signs assertions with. */
export interface SamlSettings {
  readonly kind: "saml";
  readonly entryPoint: string;
  readonly idpEntityId: string;
  /** PEM (or bare base64 DER) X.509 certificate. */
  readonly certificate: string;
}

export type IdpSettings = OidcSettings | SamlSettings;
