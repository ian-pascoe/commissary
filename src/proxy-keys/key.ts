/**
 * The text of a proxy key (ADR 0022): `cfp_<orgId>_<keyId>_<secret>`. New in the Workers port, no Go counterpart.
 *
 * The key names its org (the permanent org id, not the renamable slug), so the Worker reaches the org's ControlPlane
 * without a global lookup, and its id, so the ControlPlane finds the stored entry without searching by hash. The
 * secret is 36 random bytes (288 bits, base64url). Only the SHA-256 of the whole key is stored; a key is shown once,
 * when it is created. Pure functions only: the Worker's gate (`access/proxy-key.ts`) and the ControlPlane's store
 * (`store.ts`) share them.
 */
import { Schema } from "effect";
import { sha256Hex } from "../hash.ts";
import { OrgId } from "../platform/org.ts";

export const PROXY_KEY_PREFIX = "cfp_";

/** A key id: 20 lowercase hex characters (80 random bits); never contains the `_` that separates the key's parts. */
const KEY_ID = /^[0-9a-f]{20}$/;

/** The secret: 36 random bytes as unpadded base64url (48 characters). */
const SECRET = /^[A-Za-z0-9_-]{48}$/;

const SECRET_BYTES = 36;

/** How many characters of the secret the visible prefix shows (24 of the 288 bits). */
const SHOWN_SECRET_CHARACTERS = 4;

const isOrgId = Schema.is(OrgId);

export interface ParsedProxyKey {
  readonly org: OrgId;
  readonly keyId: string;
  /** Lowercase hex SHA-256 of the whole key: what the ControlPlane compares with the stored hash. */
  readonly hash: string;
}

export interface MintedProxyKey extends ParsedProxyKey {
  /** The whole key: returned to its member once, never stored. */
  readonly key: string;
  /** What lists show of the key, so its member recognises it: `cfp_<orgId>_<keyId>_<first 4 secret characters>`. */
  readonly prefix: string;
}

export const isKeyId = (value: string): boolean => KEY_ID.test(value);

/** Whether a client credential is meant as a proxy key (it may still be malformed). */
export const looksLikeProxyKey = (value: string): boolean => value.startsWith(PROXY_KEY_PREFIX);

/** The SHA-256 of a whole key, as stored. */
export const hashProxyKey = (key: string): string => sha256Hex(key);

const base64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

const randomHex = (bytes: number): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

/** A new key of `org` with a fresh id and secret. */
export const mintProxyKey = (org: OrgId): MintedProxyKey => {
  const keyId = randomHex(10);
  const secret = base64Url(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)));
  const key = `${PROXY_KEY_PREFIX}${org}_${keyId}_${secret}`;

  return {
    key,
    org,
    keyId,
    hash: hashProxyKey(key),
    prefix: `${PROXY_KEY_PREFIX}${org}_${keyId}_${secret.slice(0, SHOWN_SECRET_CHARACTERS)}`,
  };
};

/** The org, id and hash of a key, `undefined` when the text is not a well-formed proxy key. */
export const parseProxyKey = (text: string): ParsedProxyKey | undefined => {
  if (!looksLikeProxyKey(text)) return undefined;
  const parts = text.slice(PROXY_KEY_PREFIX.length).split("_");

  // The secret may contain `_` (base64url): the org and the id never do.
  const [org, keyId, ...rest] = parts;
  const secret = rest.join("_");

  if (org === undefined || keyId === undefined || !isOrgId(org) || !isKeyId(keyId))
    return undefined;

  return SECRET.test(secret) ? { org, keyId, hash: hashProxyKey(text) } : undefined;
};
