/**
 * The text of an API key (ADR 0022): `cms_<orgId>_<keyId>_<secret>`, and of a management key (ADR 0026):
 * `cmsm_<orgId>_<keyId>_<secret>`, shaped alike. New in the Workers port, no Go counterpart.
 *
 * The key names its org (the permanent org id, not the renamable slug), so the gate reaches the org's ControlPlane
 * without a global lookup, and its id, so the ControlPlane finds the stored entry without searching by hash. The
 * secret is 36 random bytes (288 bits, base64url). Only the SHA-256 of the whole key is stored; a key is shown once,
 * when it is created. The prefix tells the two kinds apart, so neither is ever taken for the other. Pure functions
 * only: the gates (`api-key.ts`, `management-key.ts`) and the ControlPlane's stores (`@commissary/state`'s
 * `api-keys/store.ts`, `management-keys/store.ts`) share them.
 */
import { Schema } from "effect";
import { sha256Hex, OrgId } from "@commissary/core";

export const API_KEY_PREFIX = "cms_";

/** A key id: 20 lowercase hex characters (80 random bits); never contains the `_` that separates the key's parts. */
const KEY_ID = /^[0-9a-f]{20}$/;

/** The secret: 36 random bytes as unpadded base64url (48 characters). */
const SECRET = /^[A-Za-z0-9_-]{48}$/;

const SECRET_BYTES = 36;

/** How many characters of the secret the visible prefix shows (24 of the 288 bits). */
const SHOWN_SECRET_CHARACTERS = 4;

const isOrgId = Schema.is(OrgId);

export interface ParsedApiKey {
  readonly org: OrgId;
  readonly keyId: string;
  /** Lowercase hex SHA-256 of the whole key: what the ControlPlane compares with the stored hash. */
  readonly hash: string;
}

export interface MintedApiKey extends ParsedApiKey {
  /** The whole key: returned to its member once, never stored. */
  readonly key: string;
  /** What lists show of the key, so its member recognises it: `cms_<orgId>_<keyId>_<first 4 secret characters>`. */
  readonly prefix: string;
}

export const isKeyId = (value: string): boolean => KEY_ID.test(value);

/** Whether a client credential is meant as an API key (it may still be malformed). */
export const looksLikeApiKey = (value: string): boolean => value.startsWith(API_KEY_PREFIX);

/** The SHA-256 of a whole key, as stored. */
export const hashApiKey = (key: string): string => sha256Hex(key);

const base64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

const randomHex = (bytes: number): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

/**
 * A new key of `org` with a fresh id and secret, its text starting with `prefix`: `cms_` for an API key, `cmsm_` for a
 * management key, which has the same shape.
 */
export const mintOrgKey = (prefix: string, org: OrgId): MintedApiKey => {
  const keyId = randomHex(10);
  const secret = base64Url(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)));
  const key = `${prefix}${org}_${keyId}_${secret}`;

  return {
    key,
    org,
    keyId,
    hash: hashApiKey(key),
    prefix: `${prefix}${org}_${keyId}_${secret.slice(0, SHOWN_SECRET_CHARACTERS)}`,
  };
};

/** The org, id and hash of a key starting with `prefix`, `undefined` when the text is not one well formed. */
export const parseOrgKey = (prefix: string, text: string): ParsedApiKey | undefined => {
  if (!text.startsWith(prefix)) return undefined;
  const parts = text.slice(prefix.length).split("_");

  // The secret may contain `_` (base64url): the org and the id never do.
  const [org, keyId, ...rest] = parts;
  const secret = rest.join("_");

  if (org === undefined || keyId === undefined || !isOrgId(org) || !isKeyId(keyId))
    return undefined;

  return SECRET.test(secret) ? { org, keyId, hash: hashApiKey(text) } : undefined;
};

/** A new API key of `org` with a fresh id and secret. */
export const mintApiKey = (org: OrgId): MintedApiKey => mintOrgKey(API_KEY_PREFIX, org);

/** The org, id and hash of a key, `undefined` when the text is not a well-formed API key. */
export const parseApiKey = (text: string): ParsedApiKey | undefined =>
  parseOrgKey(API_KEY_PREFIX, text);

export const MANAGEMENT_KEY_PREFIX = "cmsm_";

/** Whether a credential is meant as a management key (it may still be malformed). */
export const looksLikeManagementKey = (value: string): boolean =>
  value.startsWith(MANAGEMENT_KEY_PREFIX);

/** A new management key of `org`. */
export const mintManagementKey = (org: OrgId): MintedApiKey =>
  mintOrgKey(MANAGEMENT_KEY_PREFIX, org);

/** The org, id and hash of a management key, `undefined` when the text is not one well formed. */
export const parseManagementKey = (text: string): ParsedApiKey | undefined =>
  parseOrgKey(MANAGEMENT_KEY_PREFIX, text);
