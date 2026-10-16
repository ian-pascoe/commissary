/**
 * The part of samlify's API the Worker program uses, in place of samlify's own declarations (`paths` in
 * tsconfig.worker.json). Those import `@xmldom/xmldom`, whose `/// <reference lib="dom" />` would put the browser's
 * globals into the Worker program and break its Web Crypto and fetch types. samlify is reached through Better Auth's
 * SSO plugin (`src/hosted/auth.ts`, which never names it) and plays a test identity provider in
 * `test/hosted/identity-providers.ts`; nothing else.
 */

/** An endpoint of an entity's metadata. */
export interface Endpoint {
  readonly Binding: string;
  readonly Location: string;
}

/** The settings of an identity provider or a service provider (no metadata document: every field given). */
export interface EntitySettings {
  readonly entityID: string;
  readonly privateKey?: string;
  readonly signingCert?: string;
  readonly isAssertionEncrypted?: boolean;
  readonly wantAuthnRequestsSigned?: boolean;
  readonly authnRequestsSigned?: boolean;
  readonly wantAssertionsSigned?: boolean;
  readonly nameIDFormat?: ReadonlyArray<string>;
  readonly singleSignOnService?: ReadonlyArray<Endpoint>;
  readonly assertionConsumerService?: ReadonlyArray<Endpoint>;
}

/** A message as a binding sends it: for the POST binding, the base64 form field. */
export interface BindingContext {
  readonly context: string;
  readonly id?: string;
  readonly entityEndpoint?: string;
  readonly type?: string;
  readonly relayState?: string;
}

/** What samlify read from a parsed sign-in request. */
export interface LoginRequestExtract {
  readonly request?: { readonly id?: string };
  readonly issuer?: string;
}

export interface FlowResult {
  readonly samlContent: string;
  readonly extract: LoginRequestExtract;
}

/** A request as a binding received it: the redirect binding's query and the signed octet string. */
export interface BindingRequest {
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: Readonly<Record<string, string>>;
  readonly octetString?: string;
}

/** The person an identity provider signs in. */
export interface SamlUser {
  readonly email: string;
}

export interface ServiceProviderInstance {
  getMetadata(): string;
}

export interface IdentityProviderInstance {
  getMetadata(): string;
  parseLoginRequest(
    sp: ServiceProviderInstance,
    binding: "redirect" | "post",
    request: BindingRequest,
  ): Promise<FlowResult>;
  createLoginResponse(
    sp: ServiceProviderInstance,
    requestInfo: FlowResult | null,
    binding: "post",
    user: SamlUser,
    customTagReplacement?: undefined,
    encryptThenSign?: boolean,
    relayState?: string,
  ): Promise<BindingContext>;
}

export declare function IdentityProvider(settings: EntitySettings): IdentityProviderInstance;

export declare function ServiceProvider(settings: EntitySettings): ServiceProviderInstance;
