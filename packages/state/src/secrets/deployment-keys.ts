/**
 * The stage's secrets keys: `SECRETS_KEY`, which wraps every org's data key (`data-key.ts`), and during a rotation
 * `SECRETS_KEY_PREVIOUS`, the key it replaces. New in the Workers port.
 *
 * Fails closed like `AUTH_INDEX_KEY` (`management/auth-index.ts`): a missing, non-string or short (< 32 characters)
 * key throws. On a deployed stage (`ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` set, the condition that also refuses
 * `ACCESS_DEV_BYPASS`) the fixed `alchemy dev` key and any key shorter than 64 characters (the deploy mints 32 random
 * bytes, 256 bits, as 64 hex characters) are refused too. The ControlPlane reads them when it starts (and logs a
 * refusal, `OrgSecrets`), so a stage without its key has no ControlPlane that starts.
 */
import { isDeployedStage } from "@commissary/auth";
import { DEV_SECRETS_KEY, MIN_DEPLOYED_SECRETS_KEY_LENGTH, MIN_SECRETS_KEY_LENGTH } from "./key.ts";

/** Thrown for a missing, short or refused secrets key, and for one that opens no data key. */
export class SecretsKeyError extends Error {
  override readonly name = "SecretsKeyError";
}

/** The bindings the key check reads; each may be missing at runtime whatever the env type says. */
export interface SecretsKeyEnv {
  readonly SECRETS_KEY?: string | undefined;
  readonly SECRETS_KEY_PREVIOUS?: string | undefined;
  readonly ACCESS_TEAM_DOMAIN?: string | undefined;
  readonly ACCESS_AUD?: string | undefined;
}

/** The accepted secrets keys of the stage. */
export interface SecretsKeys {
  readonly current: string;
  /** The key `current` replaces, while a rotation is under way. */
  readonly previous?: string;
}

const refuse = (message: string): never => {
  throw new SecretsKeyError(message);
};

const check = (name: string, secret: string | undefined, deployed: boolean): string => {
  if (typeof secret !== "string" || secret.length < MIN_SECRETS_KEY_LENGTH)
    return refuse(
      `${name} is not set or shorter than ${MIN_SECRETS_KEY_LENGTH} characters: the Worker needs its secrets key (alchemy.run.ts, docs/DEPLOY.md)`,
    );

  if (deployed && (secret === DEV_SECRETS_KEY || secret.length < MIN_DEPLOYED_SECRETS_KEY_LENGTH))
    return refuse(
      `${name} is refused because ACCESS_TEAM_DOMAIN/ACCESS_AUD are set: a deployed stage needs its own random key of at least ${MIN_DEPLOYED_SECRETS_KEY_LENGTH} characters (alchemy.run.ts, docs/DEPLOY.md)`,
    );

  return secret;
};

/**
 * The secrets keys of `env`. `SECRETS_KEY` is required; `SECRETS_KEY_PREVIOUS` is optional (empty or equal to the
 * current key: none) and checked like it when set.
 */
export const deploymentSecretsKeys = (env: SecretsKeyEnv): SecretsKeys => {
  const deployed = isDeployedStage(env);

  const current = check("SECRETS_KEY", env.SECRETS_KEY, deployed);
  const previous = env.SECRETS_KEY_PREVIOUS ?? "";

  if (previous === "" || previous === current) return { current };

  return { current, previous: check("SECRETS_KEY_PREVIOUS", previous, deployed) };
};
