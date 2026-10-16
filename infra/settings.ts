import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

/**
 * Commissary Cloud's settings (ADR 0026, `COMMISSARY_MODE=cloud`): the Worker signs people in itself, so no Access application
 * is created. Secrets come from the shell (CI: the GitHub environment's secrets) and are bound as secret text.
 */
export interface HostedSettings {
  readonly githubClientId: string;
  readonly githubClientSecret: Redacted.Redacted<string>;
  readonly googleClientId: string;
  readonly googleClientSecret: Redacted.Redacted<string>;
  readonly turnstileSiteKey: string;
  readonly turnstileSecretKey: Redacted.Redacted<string>;
  /** How many orgs a person may own by default (`OWNED_ORG_LIMIT`, default 3). */
  readonly ownedOrgLimit: string;
  /** Requests per minute an org may send on the client API (`ORG_RATE_LIMIT`, default 600). */
  readonly orgRateLimit: number;
  /** The rate-limit namespace (`ORG_RATE_LIMIT_NAMESPACE_ID`): a positive integer unique in the account. */
  readonly orgRateLimitNamespaceId: number;
}

/**
 * Deploy-time settings of the stack, read from the shell environment and `.env` (see `.env.example`). They
 * are inputs of `alchemy deploy` only; the Worker itself never reads this file.
 */
export interface Settings {
  /** `COMMISSARY_MODE=cloud` (ADR 0026): set for Commissary Cloud, `undefined` for a self-hosted one (the default). */
  readonly hosted: HostedSettings | undefined;
  /**
   * Pull-request preview stage (`pr-<number>`): served on its `workers.dev` URL behind its own Access application (none
   * on Commissary Cloud), with empty storage and no cron trigger. `domain`, `existingAud` and `serviceTokens` are ignored.
   */
  readonly preview: boolean;
  /**
   * Custom hostname of the Worker (the zone must exist in the account), e.g. `commissary.example.com`. With `apiDomain`, the
   * app host: the panel, sign-in and the management API.
   */
  readonly domain: string;
  /**
   * The API host (`COMMISSARY_API_DOMAIN`, ADR 0028), e.g. `api.example.com`: the only host of the client API, which
   * leave `domain` then. Empty (the default, and always on a preview): `domain` serves everything.
   */
  readonly apiDomain: string;
  /** Access team name or domain, e.g. `myteam` or `myteam.cloudflareaccess.com`. */
  readonly teamDomain: string;
  /** AUD tag(s) of an Access application managed outside this stack; when set, no Access resources are created. */
  readonly existingAud: string;
  /** Users allowed through Access (Allow policy). */
  readonly allowEmails: ReadonlyArray<string>;
  readonly allowEmailDomains: ReadonlyArray<string>;
  /** Names of the service tokens to create (Service Auth policy), one per client/machine. */
  readonly serviceTokens: ReadonlyArray<string>;
  /** IDs of service tokens managed outside the stack (e.g. CI's) that the Service Auth policy also admits. */
  readonly allowServiceTokenIds: ReadonlyArray<string>;
  /**
   * Platform admins (ADR 0022): emails, and service token names (from `serviceTokens`) or Client IDs. They manage every
   * org (`PLATFORM_ADMIN_*`).
   */
  readonly adminEmails: ReadonlyArray<string>;
  readonly adminServiceTokens: ReadonlyArray<string>;
  /** Access session duration, e.g. `24h`. */
  readonly sessionDuration: string;
  /** Optional header Access reads a JSON service token from (single-header mode), e.g. `x-api-key`. */
  readonly serviceTokenHeader: string;
  readonly metaMintUrl: string;
  readonly cpuMs: number;
  /** Local development identity (`alchemy dev` only). */
  readonly devBypass: string;
  /**
   * Generation of the stage's secrets key (`SECRETS_KEY`, apps/app/src/secrets/): raising it mints a new key on the
   * next deploy (a rotation, docs/DEPLOY.md). Starts at 1.
   */
  readonly secretsKeyGeneration: number;
  /**
   * During a rotation, the generation the new key replaces: bound as `SECRETS_KEY_PREVIOUS` so ControlPlanes wrap their
   * data keys again. Unset once every org started under the new key.
   */
  readonly secretsKeyPreviousGeneration: number | undefined;
}

const text = (name: string, fallback = "") =>
  Config.String(name).pipe(Config.withDefault(fallback));

const list = (name: string) =>
  Config.map(text(name), (value) =>
    value
      .split(/[\s,]+/)
      .map((item) => item.trim())
      .filter((item) => item !== ""),
  );

/** A key generation: a positive integer, or `fallback` when the variable is unset or empty (CI passes unset as ""). */
const generation = (name: string, fallback: number | undefined) =>
  Effect.gen(function* () {
    const value = (yield* text(name)).trim();

    if (value === "") return fallback;

    if (!/^[1-9]\d*$/.test(value))
      return yield* Effect.die(
        new Error(`Invalid deploy settings:\n- ${name} must be a positive integer, not "${value}"`),
      );

    return Number(value);
  });

/** `SECRETS_KEY_GENERATION` and, during a rotation, `SECRETS_KEY_PREVIOUS_GENERATION` (an older one). */
const secretsKeyGenerations = Effect.gen(function* () {
  const current = (yield* generation("SECRETS_KEY_GENERATION", 1)) ?? 1;
  const previous = yield* generation("SECRETS_KEY_PREVIOUS_GENERATION", undefined);

  if (previous !== undefined && previous >= current)
    return yield* Effect.die(
      new Error(
        `Invalid deploy settings:\n- SECRETS_KEY_PREVIOUS_GENERATION (${previous}) must be lower than SECRETS_KEY_GENERATION (${current})`,
      ),
    );

  return { current, previous };
});

const TOKEN_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;

/** A hostname as a custom domain takes it: lowercase labels, at least two, no scheme, port or path. */
const HOSTNAME =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

const secret = (name: string) => Effect.map(text(name), (value) => Redacted.make(value.trim()));

/** A whole number from `min`, or `fallback` when unset; `undefined` when set to something else. */
const wholeNumber = (value: string, fallback: number, min: number): number | undefined => {
  if (value.trim() === "") return fallback;
  const parsed = Number(value.trim());

  return Number.isSafeInteger(parsed) && parsed >= min ? parsed : undefined;
};

/** `COMMISSARY_MODE`: `self-hosted` (or unset) or `cloud`. */
const commissaryMode = Effect.gen(function* () {
  const mode = (yield* text("COMMISSARY_MODE")).trim();

  if (mode === "" || mode === "self-hosted") return "self-hosted" as const;

  if (mode === "cloud") return "cloud" as const;

  return yield* Effect.die(
    new Error(
      `Invalid deploy settings:\n- COMMISSARY_MODE must be self-hosted or cloud, not "${mode}"`,
    ),
  );
});

/** The settings of Commissary Cloud, and what is wrong with them. */
const hostedSettings = Effect.gen(function* () {
  const problems: Array<string> = [];
  const limit = wholeNumber(yield* text("OWNED_ORG_LIMIT"), 3, 0);
  const rate = wholeNumber(yield* text("ORG_RATE_LIMIT"), 600, 1);
  const namespace = wholeNumber(yield* text("ORG_RATE_LIMIT_NAMESPACE_ID"), 7201, 1);

  if (limit === undefined) problems.push("OWNED_ORG_LIMIT must be a whole number from 0");

  if (rate === undefined)
    problems.push("ORG_RATE_LIMIT must be a whole number from 1 (requests per minute)");

  if (namespace === undefined)
    problems.push("ORG_RATE_LIMIT_NAMESPACE_ID must be a positive integer");

  const hosted: HostedSettings = {
    githubClientId: (yield* text("SIGN_IN_GITHUB_CLIENT_ID")).trim(),
    githubClientSecret: yield* secret("SIGN_IN_GITHUB_CLIENT_SECRET"),
    googleClientId: (yield* text("SIGN_IN_GOOGLE_CLIENT_ID")).trim(),
    googleClientSecret: yield* secret("SIGN_IN_GOOGLE_CLIENT_SECRET"),
    turnstileSiteKey: (yield* text("TURNSTILE_SITE_KEY")).trim(),
    turnstileSecretKey: yield* secret("TURNSTILE_SECRET_KEY"),
    ownedOrgLimit: String(limit ?? 3),
    orgRateLimit: rate ?? 600,
    orgRateLimitNamespaceId: namespace ?? 7201,
  };

  const github = hosted.githubClientId !== "" && Redacted.value(hosted.githubClientSecret) !== "";
  const google = hosted.googleClientId !== "" && Redacted.value(hosted.googleClientSecret) !== "";

  if (!github && !google)
    problems.push(
      "Commissary Cloud needs a sign-in provider: SIGN_IN_GITHUB_CLIENT_ID and SIGN_IN_GITHUB_CLIENT_SECRET, and/or SIGN_IN_GOOGLE_CLIENT_ID and SIGN_IN_GOOGLE_CLIENT_SECRET",
    );

  if (hosted.turnstileSiteKey === "" || Redacted.value(hosted.turnstileSecretKey) === "")
    problems.push("Commissary Cloud needs TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY");

  return { hosted, problems };
});

/** Stage names of pull-request previews (`pr-<number>`, as deployed by .github/workflows/ci.yml). */
export const PREVIEW_STAGE = /^pr-\d+$/;

/**
 * Stage of Commissary Cloud, which CI deploys from `main` next to `prod` (docs/DEPLOY.md "The Commissary Cloud stage"). Its settings live
 * in `.env.cloud` (`pnpm deploy:cloud`) and the GitHub environment `cloud`.
 */
export const CLOUD_STAGE = "cloud";

export const readSettings = (dev: boolean, stage: string) =>
  Effect.gen(function* () {
    const preview = !dev && PREVIEW_STAGE.test(stage);
    const secretsKey = yield* secretsKeyGenerations;
    const mode = yield* commissaryMode;

    // Deployed with `.env`'s self-hosted settings, the stage would claim the self-hosted Commissary's hostname.
    if (!dev && stage === CLOUD_STAGE && mode !== "cloud")
      return yield* Effect.die(
        new Error(
          `Invalid deploy settings:\n- the ${CLOUD_STAGE} stage is Commissary Cloud: set COMMISSARY_MODE=cloud (deploy it with \`pnpm deploy:cloud\`, which reads .env.cloud)`,
        ),
      );

    // `alchemy dev` stays self-hosted: the dev bypass needs it.
    const hosted = !dev && mode === "cloud" ? yield* hostedSettings : undefined;

    const settings: Settings = {
      hosted: hosted?.hosted,
      preview,
      domain: (yield* text("COMMISSARY_DOMAIN")).trim(),
      // A preview serves its workers.dev URL only (one host).
      apiDomain: dev || preview ? "" : (yield* text("COMMISSARY_API_DOMAIN")).trim(),
      teamDomain: (yield* text("ACCESS_TEAM_DOMAIN")).trim(),
      existingAud: preview ? "" : (yield* text("ACCESS_AUD")).trim(),
      allowEmails: yield* list("ACCESS_ALLOW_EMAILS"),
      allowEmailDomains: yield* list("ACCESS_ALLOW_EMAIL_DOMAINS"),
      serviceTokens: preview ? [] : yield* list("ACCESS_SERVICE_TOKENS"),
      allowServiceTokenIds: yield* list("ACCESS_ALLOW_SERVICE_TOKEN_IDS"),
      adminEmails: yield* list("PLATFORM_ADMIN_EMAILS"),
      adminServiceTokens: yield* list("PLATFORM_ADMIN_SERVICE_TOKENS"),
      sessionDuration: (yield* text("ACCESS_SESSION_DURATION", "24h")).trim(),
      serviceTokenHeader: (yield* text("ACCESS_SERVICE_TOKEN_HEADER")).trim(),
      metaMintUrl: (yield* text("META_MINT_URL")).trim(),
      cpuMs: yield* Config.Number("COMMISSARY_CPU_MS").pipe(Config.withDefault(300_000)),
      devBypass: (yield* text("ACCESS_DEV_BYPASS", "dev@example.com")).trim(),
      secretsKeyGeneration: secretsKey.current,
      secretsKeyPreviousGeneration: secretsKey.previous,
    };

    if (dev) return settings;
    const problems: Array<string> = [...(hosted?.problems ?? [])];

    if (settings.domain === "" && !preview)
      problems.push("COMMISSARY_DOMAIN is required (the Worker's custom hostname)");

    if (settings.apiDomain !== "") {
      if (!HOSTNAME.test(settings.apiDomain))
        problems.push(
          `COMMISSARY_API_DOMAIN must be a lowercase hostname such as api.example.com, not "${settings.apiDomain}"`,
        );
      else if (settings.apiDomain === settings.domain.toLowerCase())
        problems.push(
          "COMMISSARY_API_DOMAIN must differ from COMMISSARY_DOMAIN (unset it to serve everything on one host)",
        );
    }

    if (hosted !== undefined) {
      if (settings.adminServiceTokens.length > 0)
        yield* Effect.logWarning(
          "PLATFORM_ADMIN_SERVICE_TOKENS is ignored on Commissary Cloud: platform admins sign in with PLATFORM_ADMIN_EMAILS",
        );

      if (problems.length > 0)
        return yield* Effect.die(new Error(`Invalid deploy settings:\n- ${problems.join("\n- ")}`));

      // Commissary Cloud creates no Access resources and reads none of the Access settings.
      return settings;
    }

    if (settings.teamDomain === "")
      problems.push("ACCESS_TEAM_DOMAIN is required (your Zero Trust team name)");

    if (settings.existingAud === "") {
      if (
        settings.allowEmails.length === 0 &&
        settings.allowEmailDomains.length === 0 &&
        settings.serviceTokens.length === 0 &&
        settings.allowServiceTokenIds.length === 0
      ) {
        problems.push(
          "set ACCESS_ALLOW_EMAILS, ACCESS_ALLOW_EMAIL_DOMAINS, ACCESS_SERVICE_TOKENS and/or ACCESS_ALLOW_SERVICE_TOKEN_IDS, or ACCESS_AUD for an existing Access application",
        );
      }

      for (const name of settings.serviceTokens) {
        if (!TOKEN_NAME.test(name))
          problems.push(`ACCESS_SERVICE_TOKENS: "${name}" must match ${TOKEN_NAME.source}`);
      }
    } else if (settings.serviceTokens.length > 0 || settings.allowServiceTokenIds.length > 0) {
      problems.push(
        "ACCESS_SERVICE_TOKENS and ACCESS_ALLOW_SERVICE_TOKEN_IDS need a stack-managed Access application: unset ACCESS_AUD",
      );
    }

    if (problems.length > 0) {
      // The stack's error channel only carries ConfigError: report invalid combinations as a defect with a readable message.
      return yield* Effect.die(new Error(`Invalid deploy settings:\n- ${problems.join("\n- ")}`));
    }

    return settings;
  });
