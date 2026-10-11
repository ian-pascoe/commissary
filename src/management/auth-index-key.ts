/**
 * Constants of the `auth_index` key (`AUTH_INDEX_KEY`, see `auth-index.ts`), dependency-free so that the deploy
 * (alchemy.run.ts, tsconfig.infra.json) and the Worker share them.
 */

/** `auth_index` key of `alchemy dev`; public, so the Worker refuses it on a deployed stage. */
export const DEV_AUTH_INDEX_KEY = "cliproxy-dev-auth-index-key";

/** Shortest key accepted anywhere (tests and `alchemy dev` included). */
export const MIN_AUTH_INDEX_KEY_LENGTH = 16;

/** Shortest key accepted on a deployed stage: the 32 random bytes the deploy mints, hex encoded. */
export const MIN_DEPLOYED_AUTH_INDEX_KEY_LENGTH = 64;
