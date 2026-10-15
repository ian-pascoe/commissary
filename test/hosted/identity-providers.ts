// Fake identity providers for the per-org single sign-on tests (test/hosted/sso.test.ts): an OpenID Connect issuer
// that signs ID tokens with a fresh RSA key, and a SAML identity provider (samlify) with a self-signed certificate made
// here, so no key is kept in the repository.
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import * as samlify from "samlify";

// --- OpenID Connect ------------------------------------------------------------------------------------------------

export const OIDC_ISSUER = "https://login.acme-idp.com";

export const OIDC_CLIENT_ID = "proxy-client";

export const OIDC_CLIENT_SECRET = "proxy-client-secret";

/** Who the issuer signs in when it next answers a code, and the codes it issued. */
interface OidcState {
  email: string;
  tokenRequests: Array<URLSearchParams>;
}

export const oidcState: OidcState = {
  email: "olga@acme.com",
  tokenRequests: [],
};

const oidcKeys = await generateKeyPair("RS256", { extractable: true });

const oidcJwk = {
  ...(await exportJWK(oidcKeys.publicKey)),
  kid: "key-1",
  alg: "RS256",
  use: "sig",
};

/** The issuer's answer to `request`, `undefined` for any other host. */
export const oidcIssuer = async (request: Request): Promise<Response | undefined> => {
  const url = new URL(request.url);

  if (url.origin !== OIDC_ISSUER) return undefined;

  if (url.pathname === "/.well-known/openid-configuration")
    return Response.json({
      issuer: OIDC_ISSUER,
      authorization_endpoint: `${OIDC_ISSUER}/authorize`,
      token_endpoint: `${OIDC_ISSUER}/token`,
      jwks_uri: `${OIDC_ISSUER}/jwks`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic"],
    });

  if (url.pathname === "/jwks") return Response.json({ keys: [oidcJwk] });

  if (url.pathname === "/token" && request.method === "POST") {
    const form = new URLSearchParams();

    for (const [key, value] of await request.formData())
      if (typeof value === "string") form.append(key, value);
    oidcState.tokenRequests.push(form);
    const basic = request.headers.get("authorization") ?? "";

    if (basic !== `Basic ${btoa(`${OIDC_CLIENT_ID}:${OIDC_CLIENT_SECRET}`)}`)
      return Response.json({ error: "invalid_client" }, { status: 401 });
    const now = Math.floor(Date.now() / 1000);

    const idToken = await new SignJWT({
      email: oidcState.email,
      email_verified: true,
      name: "Olga",
    })
      .setProtectedHeader({ alg: "RS256", kid: "key-1" })
      .setIssuer(OIDC_ISSUER)
      .setAudience(OIDC_CLIENT_ID)
      .setSubject(`sub-${oidcState.email}`)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(oidcKeys.privateKey);

    return Response.json({
      access_token: "idp-access-token",
      token_type: "Bearer",
      expires_in: 300,
      id_token: idToken,
    });
  }

  return new Response("not found", { status: 404 });
};

// --- SAML ----------------------------------------------------------------------------------------------------------

export const SAML_ENTITY_ID = "https://idp.saml-corp.com/metadata";

export const SAML_SSO_URL = "https://idp.saml-corp.com/sso";

/** DER: a tag, its length and its content. */
const tlv = (tag: number, content: Uint8Array): Uint8Array<ArrayBuffer> => {
  const length =
    content.length < 0x80
      ? [content.length]
      : content.length < 0x100
        ? [0x81, content.length]
        : [0x82, content.length >> 8, content.length & 0xff];

  return new Uint8Array([tag, ...length, ...content]);
};

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array<ArrayBuffer> =>
  new Uint8Array(parts.flatMap((part) => [...part]));

const sequence = (...parts: ReadonlyArray<Uint8Array>) => tlv(0x30, concat(...parts));

const SHA256_WITH_RSA = new Uint8Array([
  0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b, 0x05, 0x00,
]);

const COMMON_NAME = new Uint8Array([0x06, 0x03, 0x55, 0x04, 0x03]);

const name = (commonName: string) =>
  sequence(tlv(0x31, sequence(COMMON_NAME, tlv(0x0c, new TextEncoder().encode(commonName)))));

/** UTCTime `YYMMDDHHMMSSZ` (years before 2050). */
const utcTime = (date: Date) =>
  tlv(0x17, new TextEncoder().encode(`${date.toISOString().slice(2, 19).replace(/[-T:]/g, "")}Z`));

/** A key exported as DER (`spki`, `pkcs8`). */
const exported = async (
  format: "spki" | "pkcs8",
  key: CryptoKey,
): Promise<Uint8Array<ArrayBuffer>> => {
  const der = await crypto.subtle.exportKey(format, key);

  if (!(der instanceof ArrayBuffer)) throw new Error(`${format} export is not DER`);

  return new Uint8Array(der);
};

const pem = (label: string, der: Uint8Array): string => {
  const base64 = btoa(String.fromCharCode(...der));
  const lines = base64.match(/.{1,64}/g) ?? [];

  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
};

/** A fresh RSA key and a self-signed certificate for it, valid from yesterday for a year, as PEM. */
const selfSigned = async (commonName: string) => {
  const keys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );

  if (!("privateKey" in keys)) throw new Error("RSA generated no key pair");

  const day = 86_400_000;
  const now = Date.now();

  const tbs = sequence(
    tlv(0xa0, tlv(0x02, new Uint8Array([2]))),
    tlv(0x02, new Uint8Array([1])),
    sequence(SHA256_WITH_RSA),
    name(commonName),
    sequence(utcTime(new Date(now - day)), utcTime(new Date(now + 365 * day))),
    name(commonName),
    await exported("spki", keys.publicKey),
  );

  const signature = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, tbs),
  );

  const certificate = sequence(
    tbs,
    sequence(SHA256_WITH_RSA),
    tlv(0x03, concat(new Uint8Array([0]), signature)),
  );

  return {
    certificate: pem("CERTIFICATE", certificate),
    privateKey: pem("PRIVATE KEY", await exported("pkcs8", keys.privateKey)),
  };
};

const samlKeys = await selfSigned("idp.saml-corp.com");

/** The certificate the SAML identity provider signs with (what an org owner pastes into the settings). */
export const SAML_CERTIFICATE = samlKeys.certificate;

const POST_BINDING = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST";

const REDIRECT_BINDING = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect";

const samlIdp = samlify.IdentityProvider({
  entityID: SAML_ENTITY_ID,
  privateKey: samlKeys.privateKey,
  signingCert: samlKeys.certificate,
  isAssertionEncrypted: false,
  wantAuthnRequestsSigned: false,
  singleSignOnService: [{ Binding: REDIRECT_BINDING, Location: SAML_SSO_URL }],
  nameIDFormat: ["urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"],
});

/**
 * The identity provider's answer to the sign-in request `redirect` (the URL Commissary sent the browser to): the form
 * fields its page would post to Commissary's assertion consumer service, signing `email` in.
 */
export const samlAnswer = async (
  redirect: string,
  sp: { readonly entityId: string; readonly acsUrl: string },
  email: string,
): Promise<{ readonly SAMLResponse: string; readonly RelayState: string }> => {
  const url = new URL(redirect);
  const query = Object.fromEntries(url.searchParams);

  const serviceProvider = samlify.ServiceProvider({
    entityID: sp.entityId,
    assertionConsumerService: [{ Binding: POST_BINDING, Location: sp.acsUrl }],
    wantAssertionsSigned: true,
    authnRequestsSigned: false,
  });

  const request = await samlIdp.parseLoginRequest(serviceProvider, "redirect", {
    query,
    octetString: url.search.slice(1),
  });

  const response = await samlIdp.createLoginResponse(
    serviceProvider,
    request,
    "post",
    { email },
    undefined,
    false,
    query["RelayState"],
  );

  return { SAMLResponse: response.context, RelayState: query["RelayState"] ?? "" };
};
