/**
 * An org's single sign-on inside its ControlPlane Durable Object (SQLite; issue #76, hosted proxies only): its one
 * identity provider (OIDC or SAML) and its email domains. New in the Workers port, no Go counterpart.
 *
 * The provider's settings are one row, sealed whole with the org's data key like every stored secret (an OIDC client
 * secret is one); a domain is a row with its verification token, when it was verified, and whether the org requires
 * single sign-on for it. The Platform registry keeps the copy of the verified domains a sign-in looks up
 * (`PlatformStore.claimSsoDomain`); this store stays authoritative, so a sign-in checks both.
 *
 * Single sign-on can be required for a verified domain only while a provider is set, and the provider cannot be
 * removed while a domain requires it: the people of that domain would have no way in.
 *
 * All methods are synchronous; refusals are plain data. Times are the caller's clock (epoch milliseconds).
 */
import type { Sealer } from "../secrets/cipher.ts";
import { type IdpSettings, normalizeDomain } from "@commissary/auth/sso";

export interface StoredIdp {
  readonly settings: IdpSettings;
  readonly updatedAt: number;
  /** Who set it: an email, or `service:<client id>`. */
  readonly updatedBy: string;
}

export interface SsoDomain {
  /** Lowercased, no trailing dot. */
  readonly domain: string;
  /** The value the TXT record must carry (`@commissary/auth/sso` `challengeRecord`). */
  readonly token: string;
  readonly addedAt: number;
  /** When the TXT record was found; absent while the domain is unverified. */
  readonly verifiedAt?: number;
  readonly requireSso: boolean;
}

export interface SsoState {
  readonly provider?: StoredIdp;
  readonly domains: ReadonlyArray<SsoDomain>;
}

export type SsoErrorCode =
  | "invalid_domain"
  | "domain_exists"
  | "too_many_domains"
  | "domain_not_found"
  | "domain_unverified"
  | "provider_missing"
  | "client_secret_required"
  | "sso_required";

export type SsoResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: SsoErrorCode; readonly message: string };

/** At most this many domains per org, so an org cannot fill its storage. */
export const MAX_SSO_DOMAINS = 20;

const PROVIDER_CONTEXT = "sso_provider/1";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sso_provider (
     id INTEGER PRIMARY KEY CHECK (id = 1), settings TEXT NOT NULL, updated_at INTEGER NOT NULL,
     updated_by TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS sso_domains (
     domain TEXT PRIMARY KEY, token TEXT NOT NULL, added_at INTEGER NOT NULL, verified_at INTEGER,
     require_sso INTEGER NOT NULL DEFAULT 0
   )`,
];

interface ProviderRow {
  settings: string;
  updated_at: number;
  updated_by: string;
  [column: string]: SqlStorageValue;
}

interface DomainRow {
  domain: string;
  token: string;
  added_at: number;
  verified_at: number | null;
  require_sso: number;
  [column: string]: SqlStorageValue;
}

const DOMAIN_COLUMNS = "domain, token, added_at, verified_at, require_sso";

const refused = (error: SsoErrorCode, message: string): SsoResult<never> => ({
  ok: false,
  error,
  message,
});

const domainOf = (row: DomainRow): SsoDomain => ({
  domain: row.domain,
  token: row.token,
  addedAt: row.added_at,
  ...(row.verified_at === null ? {} : { verifiedAt: row.verified_at }),
  requireSso: row.require_sso === 1,
});

/** A fresh verification token: 128 random bits, hex. */
const freshToken = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

export class SsoStore {
  readonly #sql: SqlStorage;
  readonly #secrets: Sealer;

  constructor(sql: SqlStorage, secrets: Sealer) {
    this.#sql = sql;
    this.#secrets = secrets;

    for (const statement of SCHEMA) sql.exec(statement);
  }

  state(): SsoState {
    const provider = this.provider();

    return { ...(provider === undefined ? {} : { provider }), domains: this.domains() };
  }

  provider(): StoredIdp | undefined {
    const row = this.#sql
      .exec<ProviderRow>(`SELECT settings, updated_at, updated_by FROM sso_provider WHERE id = 1`)
      .toArray()[0];

    if (row === undefined) return undefined;

    return {
      // SAFETY: the value opened is the JSON text `setProvider` sealed from an `IdpSettings`.
      settings: JSON.parse(this.#secrets.open(row.settings, PROVIDER_CONTEXT)) as IdpSettings,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    };
  }

  domains(): ReadonlyArray<SsoDomain> {
    return this.#sql
      .exec<DomainRow>(`SELECT ${DOMAIN_COLUMNS} FROM sso_domains ORDER BY domain`)
      .toArray()
      .map(domainOf);
  }

  /**
   * Sets the org's identity provider, replacing any other. An OIDC provider without a client secret keeps the secret of
   * the OIDC provider set before (a form that does not show the secret saves without it); there must be one.
   */
  setProvider(settings: IdpSettings, by: string, now: number): SsoResult<StoredIdp> {
    let next = settings;

    if (settings.kind === "oidc" && settings.clientSecret === "") {
      const current = this.provider()?.settings;

      if (current?.kind !== "oidc" || current.clientSecret === "")
        return refused(
          "client_secret_required",
          "an OIDC identity provider needs its client secret",
        );
      next = { ...settings, clientSecret: current.clientSecret };
    }

    this.#sql.exec(
      `INSERT INTO sso_provider (id, settings, updated_at, updated_by) VALUES (1, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
      this.#secrets.seal(JSON.stringify(next), PROVIDER_CONTEXT),
      now,
      by,
    );

    return { ok: true, value: { settings: next, updatedAt: now, updatedBy: by } };
  }

  /** Removes the provider; refused while a domain requires single sign-on. */
  removeProvider(): SsoResult<StoredIdp> {
    const current = this.provider();

    if (current === undefined) return refused("provider_missing", "no identity provider is set");

    if (this.domains().some((domain) => domain.requireSso))
      return refused(
        "sso_required",
        "a domain requires single sign-on: stop requiring it before removing the identity provider",
      );
    this.#sql.exec(`DELETE FROM sso_provider WHERE id = 1`);

    return { ok: true, value: current };
  }

  /** Adds an unverified domain with a fresh token (`domain` is normalized here). */
  addDomain(input: string, now: number): SsoResult<SsoDomain> {
    const domain = normalizeDomain(input);

    if (domain === undefined)
      return refused("invalid_domain", "a domain is a DNS name such as example.com");

    if (this.domain(domain).ok)
      return refused("domain_exists", `the domain ${domain} is added already`);

    if (this.domains().length >= MAX_SSO_DOMAINS)
      return refused("too_many_domains", `an org has at most ${MAX_SSO_DOMAINS} domains`);
    const token = freshToken();

    this.#sql.exec(
      `INSERT INTO sso_domains (domain, token, added_at) VALUES (?, ?, ?)`,
      domain,
      token,
      now,
    );

    return { ok: true, value: { domain, token, addedAt: now, requireSso: false } };
  }

  /** The domain as stored; `domain_not_found` for one the org has not added. */
  domain(input: string): SsoResult<SsoDomain> {
    const row = this.#sql
      .exec<DomainRow>(
        `SELECT ${DOMAIN_COLUMNS} FROM sso_domains WHERE domain = ?`,
        normalizeDomain(input) ?? "",
      )
      .toArray()[0];

    return row === undefined
      ? refused("domain_not_found", "the org has not added this domain")
      : { ok: true, value: domainOf(row) };
  }

  /** Marks the domain verified (its TXT record was found and the registry gave it to the org). */
  markVerified(input: string, now: number): SsoResult<SsoDomain> {
    const found = this.domain(input);

    if (!found.ok || found.value.verifiedAt !== undefined) return found;
    this.#sql.exec(
      `UPDATE sso_domains SET verified_at = ? WHERE domain = ?`,
      now,
      found.value.domain,
    );

    return { ok: true, value: { ...found.value, verifiedAt: now } };
  }

  /** Requires single sign-on for a verified domain, or stops requiring it; requiring it needs a provider. */
  setRequired(input: string, required: boolean): SsoResult<SsoDomain> {
    const found = this.domain(input);

    if (!found.ok) return found;

    if (required && found.value.verifiedAt === undefined)
      return refused("domain_unverified", "verify the domain before requiring single sign-on");

    if (required && this.provider() === undefined)
      return refused(
        "provider_missing",
        "set an identity provider before requiring single sign-on",
      );
    this.#sql.exec(
      `UPDATE sso_domains SET require_sso = ? WHERE domain = ?`,
      required ? 1 : 0,
      found.value.domain,
    );

    return { ok: true, value: { ...found.value, requireSso: required } };
  }

  /** Removes the domain (verified or not); the caller frees it in the registry. */
  removeDomain(input: string): SsoResult<SsoDomain> {
    const found = this.domain(input);

    if (!found.ok) return found;
    this.#sql.exec(`DELETE FROM sso_domains WHERE domain = ?`, found.value.domain);

    return found;
  }
}
