/**
 * The text of a management key (ADR 0026): `cmsm_<orgId>_<keyId>_<secret>`, shaped like an API key
 * (`api-keys/key.ts`: the org id, a 20-hex-character id and a 288-bit secret; only the SHA-256 of the whole key is
 * stored). The prefix tells the two apart, so neither is ever taken for the other. New in the Workers port.
 */
import { mintOrgKey, type MintedApiKey, type ParsedApiKey, parseOrgKey } from "../api-keys/key.ts";
import type { OrgId } from "../platform/org.ts";

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
