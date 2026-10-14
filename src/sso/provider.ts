/**
 * An org's identity provider as Better Auth's SSO plugin sees it (issue #76): one provider per org, `sso-<org id>`,
 * built on each use from what the org's ControlPlane stores (`store.ts`) and never written to Better Auth's database
 * (`hosted/auth.ts` answers the plugin's `ssoProvider` reads with it). New in the Workers port.
 *
 * Its domains are the org's verified domains; the plugin refuses a provider without one (`domainVerified`). OIDC uses
 * PKCE besides the client secret, and SAML takes only signed assertions for this proxy (its entity id, the audience),
 * sent to its assertion consumer service in answer to a request it made.
 */
import { Schema } from "effect";
import { AUTH_BASE_PATH } from "../hosted/auth.ts";
import { OrgId } from "../platform/org.ts";
import type { IdpSettings } from "./store.ts";

const PREFIX = "sso-";

/** The Better Auth provider id of `org`'s identity provider. */
export const providerIdOf = (org: OrgId): string => `${PREFIX}${org}`;

/** The org whose identity provider `providerId` names; `undefined` for anything else. */
export const orgOfProviderId = (providerId: string): OrgId | undefined => {
  const org = providerId.startsWith(PREFIX) ? providerId.slice(PREFIX.length) : "";

  return Schema.is(OrgId)(org) ? org : undefined;
};

/** The proxy's side of `org`'s provider at `origin` (`https://<host>`): what the identity provider is told. */
export const serviceProviderOf = (origin: string, org: OrgId) => {
  const id = providerIdOf(org);
  const metadata = `${origin}${AUTH_BASE_PATH}/sso/saml2/sp/metadata?providerId=${id}`;

  return {
    oidcRedirectUri: `${origin}${AUTH_BASE_PATH}/sso/callback/${id}`,
    samlAcsUrl: `${origin}${AUTH_BASE_PATH}/sso/saml2/sp/acs/${id}`,
    samlEntityId: metadata,
    samlMetadataUrl: metadata,
  };
};

/** SAML's name id format for an email address. */
const EMAIL_NAME_ID = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";

/** A row of Better Auth's `ssoProvider` model (configs as JSON text, as the plugin stores them). */
export interface BetterAuthSsoProvider {
  readonly providerId: string;
  readonly issuer: string;
  /** Comma-separated. */
  readonly domain: string;
  readonly domainVerified: boolean;
  readonly organizationId: string;
  readonly userId: string;
  readonly oidcConfig?: string;
  readonly samlConfig?: string;
}

/**
 * The plugin's provider for `org` at `origin`, from its settings and verified domains; `undefined` without a verified
 * domain (nobody could sign in through it).
 */
export const betterAuthProvider = (
  origin: string,
  org: OrgId,
  settings: IdpSettings,
  verifiedDomains: ReadonlyArray<string>,
): BetterAuthSsoProvider | undefined => {
  if (verifiedDomains.length === 0) return undefined;

  const base = {
    providerId: providerIdOf(org),
    domain: verifiedDomains.join(","),
    domainVerified: true,
    organizationId: org,
    userId: "",
  };

  if (settings.kind === "oidc")
    return {
      ...base,
      issuer: settings.issuer,
      oidcConfig: JSON.stringify({
        issuer: settings.issuer,
        clientId: settings.clientId,
        clientSecret: settings.clientSecret,
        authorizationEndpoint: settings.authorizationEndpoint,
        tokenEndpoint: settings.tokenEndpoint,
        jwksEndpoint: settings.jwksEndpoint,
        ...(settings.userInfoEndpoint === undefined
          ? {}
          : { userInfoEndpoint: settings.userInfoEndpoint }),
        tokenEndpointAuthentication: settings.tokenEndpointAuthentication ?? "client_secret_basic",
        pkce: true,
        scopes: ["openid", "email", "profile"],
      }),
    };
  const sp = serviceProviderOf(origin, org);

  return {
    ...base,
    issuer: settings.idpEntityId,
    samlConfig: JSON.stringify({
      issuer: sp.samlEntityId,
      entryPoint: settings.entryPoint,
      cert: settings.certificate,
      callbackUrl: "/",
      idpMetadata: { entityID: settings.idpEntityId },
      spMetadata: { entityID: sp.samlEntityId },
      wantAssertionsSigned: true,
      identifierFormat: EMAIL_NAME_ID,
    }),
  };
};
