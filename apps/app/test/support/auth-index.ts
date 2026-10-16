// The test deployment's keyed `auth_index`, and the unkeyed values it replaced (for leak checks).
import { createHash, createHmac } from "node:crypto";
import { env } from "cloudflare:workers";
import { authIndexer } from "../../src/models/management/auth-index.ts";

/** `auth_index` under the test key (`AUTH_INDEX_KEY` in vitest.config.ts). */
export const authIndexOf = authIndexer(env.AUTH_INDEX_KEY);

/** The former, unsalted `auth_index` (Go's `stableAuthIndex` over `id:<id>`): must never be answered. */
export const unkeyedAuthIndexOf = (credentialId: string): string =>
  createHash("sha256").update(`id:${credentialId}`).digest("hex").slice(0, 16);

/** HMAC under a 0-byte key, what a missing `AUTH_INDEX_KEY` used to produce: must never be answered either. */
export const emptyKeyAuthIndexOf = (credentialId: string): string =>
  createHmac("sha256", Buffer.alloc(0))
    .update(`auth-index:${credentialId}`, "utf8")
    .digest("hex")
    .slice(0, 16);
