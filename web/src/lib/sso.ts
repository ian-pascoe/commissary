// Per-org single sign-on (issue #76, Commissary Cloud only): what the Single sign-on page and the sign-in page's work email
// form need beyond the contract. Provider forms and their checks (which mirror the server's, never stricter), the
// payloads they send, how a refused write reads, and what the page says about a domain. Pure: no DOM, tested in
// test/web-sso.test.ts.
import type {
  SsoDomainView,
  SsoProviderInput,
  SsoProviderView,
  SsoSettings,
} from "#contract/sso.ts";
import { asSentence } from "./failure.ts";
import { formatDate } from "./format.ts";
import { emailProblem } from "./members.ts";
import { atLeast, type Caller } from "./role.ts";
import { signInRequestProblem } from "./sign-in.ts";

/** Only org owners change single sign-on; org admins read it. */
export const canChangeSso = (caller: Caller): boolean => atLeast(caller.role, "owner");

/** The most domains an org may add (the server refuses more with `too_many_domains`). */
export const SSO_DOMAINS_MAX = 20;

// ---------------------------------------------------------------------------------------------------------------
// The identity provider form

export type ProviderKind = "oidc" | "saml";

/** The choices of the provider form, in the order the page offers them. */
export const PROVIDER_KINDS: ReadonlyArray<ProviderKind> = ["oidc", "saml"];

const KIND_LABELS: Readonly<Record<ProviderKind, string>> = {
  oidc: "OpenID Connect",
  saml: "SAML 2.0",
};

export const providerKindLabel = (kind: ProviderKind): string => KIND_LABELS[kind];

/**
 * What the provider form holds. Both protocols keep their fields, so switching between them loses nothing typed. The
 * client secret and the certificate are never read back from the server: they start empty.
 */
export interface ProviderDraft {
  readonly kind: ProviderKind;
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly entryPoint: string;
  readonly idpEntityId: string;
  readonly certificate: string;
}

export type ProviderField =
  | "issuer"
  | "clientId"
  | "clientSecret"
  | "entryPoint"
  | "idpEntityId"
  | "certificate";

export type ProviderProblems = Readonly<Partial<Record<ProviderField, string>>>;

/** The form for a saved provider (its public fields), or an empty OpenID Connect form. */
export const draftOf = (provider: SsoProviderView | null): ProviderDraft => {
  const empty: ProviderDraft = {
    kind: "oidc",
    issuer: "",
    clientId: "",
    clientSecret: "",
    entryPoint: "",
    idpEntityId: "",
    certificate: "",
  };

  if (provider === null) return empty;

  return provider.kind === "oidc"
    ? { ...empty, kind: "oidc", issuer: provider.issuer, clientId: provider.client_id }
    : {
        ...empty,
        kind: "saml",
        entryPoint: provider.entry_point,
        idpEntityId: provider.idp_entity_id,
      };
};

/** Whether a client secret is already stored: a saved OpenID Connect provider always has one. */
export const secretStored = (stored: SsoProviderView | null): boolean => stored?.kind === "oidc";

/** The longest text the server takes for a field (`src/sso/idp.ts`). */
const TEXT_MAX = 2048;

const CERTIFICATE_MAX = 16_384;

/** Whether `text` is an https address with a host and no credentials (the server also wants a public host). */
const isHttpsUrl = (text: string): boolean => {
  try {
    const url = new URL(text.trim());

    return (
      url.protocol === "https:" && url.hostname !== "" && url.username === "" && url.password === ""
    );
  } catch {
    return false;
  }
};

const BEGIN_CERTIFICATE = /-----BEGIN CERTIFICATE-----/;

const BASE64_BODY = /^[A-Za-z0-9+/=\s]+$/;

/** A certificate is PEM, or the base64 body of one. */
const looksLikeCertificate = (text: string): boolean =>
  BEGIN_CERTIFICATE.test(text) || BASE64_BODY.test(text.trim());

const requiredText = (text: string, what: string): string | undefined => {
  const trimmed = text.trim();

  if (trimmed === "") return `Enter ${what}.`;

  return trimmed.length > TEXT_MAX
    ? `${what[0]?.toUpperCase() ?? ""}${what.slice(1)} is too long.`
    : undefined;
};

/** A required https address: what is wrong with it, or `undefined`. */
const urlProblem = (text: string, what: string, example: string): string | undefined => {
  const missing = requiredText(text, `the ${what}`);

  if (missing !== undefined) return missing;

  return isHttpsUrl(text) ? undefined : `The ${what} is an https address, like ${example}.`;
};

const certificateProblem = (text: string): string | undefined => {
  const certificate = text.trim();

  if (certificate === "") return "Paste the certificate the provider signs with.";

  return certificate.length > CERTIFICATE_MAX || !looksLikeCertificate(certificate)
    ? "That is not a certificate. Paste the PEM text, or its base64 body."
    : undefined;
};

const secretProblem = (secret: string, stored: SsoProviderView | null): string | undefined => {
  if (secret.trim() === "" && !secretStored(stored))
    return "Enter the client secret the provider gave you.";

  return secret.length > TEXT_MAX ? "The client secret is too long." : undefined;
};

/** Keeps the fields that have a problem. */
const problemsOf = (
  found: ReadonlyArray<readonly [ProviderField, string | undefined]>,
): ProviderProblems =>
  Object.fromEntries(
    found.flatMap(([field, problem]) => (problem === undefined ? [] : [[field, problem]])),
  );

/** What is wrong with the form, by field. A new OpenID Connect provider needs its secret; a saved one keeps it. */
export const providerProblems = (
  draft: ProviderDraft,
  stored: SsoProviderView | null,
): ProviderProblems =>
  draft.kind === "oidc"
    ? problemsOf([
        ["issuer", urlProblem(draft.issuer, "issuer address", "https://login.example.com")],
        ["clientId", requiredText(draft.clientId, "the client ID")],
        ["clientSecret", secretProblem(draft.clientSecret, stored)],
      ])
    : problemsOf([
        ["entryPoint", urlProblem(draft.entryPoint, "sign-in URL", "https://idp.example.com/sso")],
        ["idpEntityId", requiredText(draft.idpEntityId, "the entity ID")],
        ["certificate", certificateProblem(draft.certificate)],
      ]);

/** The body of `PUT /sso/provider`: trimmed, and without a client secret when none was typed (the server keeps it). */
export const providerPayload = (draft: ProviderDraft): SsoProviderInput => {
  if (draft.kind === "oidc") {
    const secret = draft.clientSecret.trim();

    const oidc = {
      kind: "oidc",
      issuer: draft.issuer.trim(),
      client_id: draft.clientId.trim(),
    } as const;

    return secret === "" ? oidc : { ...oidc, client_secret: secret };
  }

  return {
    kind: "saml",
    entry_point: draft.entryPoint.trim(),
    idp_entity_id: draft.idpEntityId.trim(),
    certificate: draft.certificate.trim(),
  };
};

/** A labelled value the page shows (a saved provider's facts, what the identity provider is told). */
export interface Fact {
  readonly label: string;
  readonly value: string;
}

/** What the page shows of a saved provider. Never a secret: the server sends none. */
export const providerFacts = (provider: SsoProviderView): ReadonlyArray<Fact> => {
  const changed: Fact = {
    label: "Last changed",
    value: `${formatDate(Date.parse(provider.updated_at))} by ${provider.updated_by}`,
  };

  if (provider.kind === "oidc")
    return [
      { label: "Type", value: providerKindLabel("oidc") },
      { label: "Issuer", value: provider.issuer },
      { label: "Client ID", value: provider.client_id },
      { label: "Client secret", value: "Stored. It is never shown again." },
      changed,
    ];

  return [
    { label: "Type", value: providerKindLabel("saml") },
    { label: "Sign-in URL", value: provider.entry_point },
    { label: "Entity ID", value: provider.idp_entity_id },
    {
      label: "Certificate",
      value: `Expires ${formatDate(Date.parse(provider.certificate_expires_at))}`,
    },
    changed,
  ];
};

/** What the identity provider must be told about Commissary, for the protocol being set up. */
export const serviceProviderFacts = (
  service: SsoSettings["service_provider"],
  kind: ProviderKind,
): ReadonlyArray<Fact> =>
  kind === "oidc"
    ? [{ label: "Redirect URI", value: service.oidc_redirect_uri }]
    : [
        { label: "ACS URL (HTTP-POST)", value: service.saml_acs_url },
        { label: "Entity ID (audience)", value: service.saml_entity_id },
        { label: "Metadata URL", value: service.saml_metadata_url },
      ];

/** Why a provider cannot be removed yet, or `undefined`: a domain that requires single sign-on needs it. */
export const removeProviderBlock = (domains: ReadonlyArray<SsoDomainView>): string | undefined => {
  const required = domains.flatMap((domain) => (domain.require_sso ? [domain.domain] : []));

  return required.length === 0
    ? undefined
    : `${required.join(", ")} requires single sign-on. Turn that off first.`;
};

// ---------------------------------------------------------------------------------------------------------------
// Domains

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const ALL_DIGITS = /^[0-9]+$/;

/** A typed domain as the server stores it (`src/sso/domain.ts`): trimmed, lower-case, no trailing dot; else `undefined`. */
export const normalizeDomain = (text: string): string | undefined => {
  const domain = text.trim().toLowerCase().replace(/\.$/, "");

  if (domain === "" || domain.length > 253) return undefined;
  const labels = domain.split(".");

  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return undefined;

  return ALL_DIGITS.test(labels.at(-1) ?? "") ? undefined : domain;
};

/** What is wrong with a typed domain, or `undefined` when it will do. */
export const domainProblem = (text: string): string | undefined => {
  if (text.trim() === "") return "Enter a domain, like acme.com.";

  if (text.includes("@")) return "Enter the domain only, like acme.com, not an email address.";

  if (text.includes("/") || text.includes(":"))
    return "Enter the domain only, like acme.com, without https:// or a path.";

  return normalizeDomain(text) === undefined
    ? "That is not a domain name. Write it like acme.com; a subdomain is a domain of its own."
    : undefined;
};

/** What a domain row says about itself. */
export const domainStatus = (domain: SsoDomainView): string =>
  domain.verified
    ? domain.verified_at === undefined
      ? "Verified"
      : `Verified ${formatDate(Date.parse(domain.verified_at))}`
    : "Not verified yet";

/** Why "Require single sign-on" is off for a domain, or `undefined` when it can be switched on. */
export const requireBlock = (
  domain: SsoDomainView,
  provider: SsoProviderView | null,
): string | undefined => {
  if (!domain.verified) return "Verify the domain first.";

  if (provider === null && !domain.require_sso) return "Set an identity provider first.";

  return undefined;
};

/** Domains in the order the page lists them: verified first, then by name. */
export const sortDomains = (domains: ReadonlyArray<SsoDomainView>): ReadonlyArray<SsoDomainView> =>
  domains.toSorted(
    (a, b) => Number(b.verified) - Number(a.verified) || a.domain.localeCompare(b.domain),
  );

// ---------------------------------------------------------------------------------------------------------------
// Refusals

/**
 * What a refused single sign-on write or test says, by the server's error code. Codes without copy fall back to the
 * server's own explanation, then to the code.
 */
export const ssoProblem = (error: string | undefined, message: string, detail?: string): string => {
  const explained = detail === undefined ? undefined : asSentence(detail);

  switch (error) {
    case "owner_required":
      return "Only an org owner can change single sign-on.";
    case "management_key_forbidden":
      return "A management key cannot change single sign-on. Sign in as an org owner to do it.";
    case "sso_required":
      return "A domain of this org requires single sign-on. Turn that off for every domain first.";
    case "invalid_provider":
      return explained === undefined
        ? "The provider’s settings were refused. Check each field."
        : `The provider’s settings were refused. ${explained}`;
    case "discovery_failed":
      return explained === undefined
        ? "The issuer’s discovery document could not be used."
        : `The issuer’s discovery document could not be used. ${explained}`;
    case "provider_unreachable":
      return explained ?? "The identity provider could not be reached. Try again in a moment.";
    case "client_secret_required":
      return "A new OpenID Connect provider needs its client secret.";
    case "provider_missing":
      return "No identity provider is set. Reload to see the current settings.";
    case "invalid_domain":
      return "That is not a domain name. Write it like acme.com.";
    case "domain_exists":
      return "This org has that domain already.";
    case "too_many_domains":
      return `An org has at most ${SSO_DOMAINS_MAX} domains. Remove one first.`;
    case "record_not_found":
      return "We did not find the TXT record yet. DNS changes can take a few minutes to spread; check its name and value, then verify again.";
    case "dns_unavailable":
      return "The DNS lookup failed. Try again in a moment.";
    case "domain_taken":
      return "Another org has verified this domain already. A domain belongs to one org.";
    case "domain_unverified":
      return "Verify the domain before requiring single sign-on for it.";
    case "domain_not_found":
      return "That domain is no longer listed. Reload to see the current list.";
    case "sessions_not_ended":
      return "Single sign-on is required now, but some sessions could not be ended. Turn the requirement off and on again to retry.";
    default:
      return explained ?? message;
  }
};

// ---------------------------------------------------------------------------------------------------------------
// The sign-in page's work email form

/** What is wrong with a typed work email, or `undefined`. */
export const workEmailProblem = (text: string): string | undefined => emailProblem(text);

/** What a refused `POST` to the single sign-on route says, by status and the server's error code. */
export const workSignInProblem = (status: number, error: string | undefined): string =>
  status === 404 && error === "sso_not_found"
    ? "No organization signs people in with that email’s domain. Check the address, or ask an org owner to set up single sign-on."
    : signInRequestProblem(status);
