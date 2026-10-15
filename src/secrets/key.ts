/**
 * Constants of the secrets key (`SECRETS_KEY`, see `deployment-keys.ts`), dependency-free so that the deploy
 * (alchemy.run.ts, tsconfig.infra.json) and the Worker share them.
 */

/** Secrets key of `alchemy dev`; public, so the Worker refuses it on a deployed stage. */
export const DEV_SECRETS_KEY = "commissary-dev-secrets-key-not-secret-0123456789abcdef0123456789";

/** Shortest secrets key accepted anywhere (tests and `alchemy dev` included). */
export const MIN_SECRETS_KEY_LENGTH = 32;

/** Shortest secrets key accepted on a deployed stage: the 32 random bytes (256 bits) the deploy mints, hex encoded. */
export const MIN_DEPLOYED_SECRETS_KEY_LENGTH = 64;

/**
 * Alchemy resource id of the minted secrets key of `generation` (infra/settings.ts `SECRETS_KEY_GENERATION`): the
 * first generation keeps the plain name, so rotating mints a new resource next to it.
 */
export const secretsKeyResourceId = (generation: number): string =>
  generation === 1 ? "SecretsKey" : `SecretsKey${generation}`;
