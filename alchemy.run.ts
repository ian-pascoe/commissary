/**
 * Infrastructure of the Workers port, deployed with Alchemy (`pnpm deploy`, `pnpm dev`, `pnpm destroy`): the state
 * Worker, which defines the Durable Objects (ADR 0030), the app Worker with its static assets and cron trigger, which
 * binds them by script name, the KV namespace, the D1 usage database (migrations
 * applied on every deploy), the `auth_index` HMAC key and the Cloudflare Access application, policies and service tokens
 * in front of it (except the client API, where clients send API keys). Commissary Cloud (`COMMISSARY_MODE=cloud`, ADR
 * 0026) creates no Access resources: the Worker signs people in itself, and gets its sign-in settings, Better Auth's
 * secret and the per-org rate limit instead.
 * Deploy-time settings are read from the environment / `.env` (see `.env.example` and infra/settings.ts).
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Output from "alchemy/Output";
import { type AccessWiring, provisionAccess, provisionClientApiBypass } from "./infra/access.ts";
import { BUNDLE_ALIASES } from "./infra/bundle.ts";
import { readSettings } from "./infra/settings.ts";
import { DEV_AUTH_INDEX_KEY } from "@commissary/models/auth-index-key";
import { DEV_SECRETS_KEY, secretsKeyResourceId } from "./packages/state/src/secrets/key.ts";

/**
 * Runtime compatibility of the Workers; keep in sync with apps/app/vitest.config.ts, packages/state/vitest.config.ts,
 * packages/models/vitest.config.ts and tools/workers/worker-configuration.d.ts.
 */
export const COMPATIBILITY = { date: "2026-08-01", flags: ["nodejs_compat"] };

/** Model catalog refresh, credential refresh sweep and usage retention (apps/app/src/api/scheduled.ts). */
export const CRONS = ["0 */3 * * *"];

// Remote state in the account (`Cloudflare.state()`, shared by every machine and CI) unless ALCHEMY_STATE=local,
// which keeps it under .alchemy/ (handy for `alchemy dev` without a Cloudflare login).
const state = process.env["ALCHEMY_STATE"] === "local" ? Alchemy.localState() : Cloudflare.state();

export default Alchemy.Stack(
  "commissary",
  { providers: Cloudflare.providers(), state },
  Effect.gen(function* () {
    const dev = yield* Alchemy.ALCHEMY_DEV;
    const settings = yield* readSettings(dev, yield* Alchemy.Stage);

    const cache = yield* Cloudflare.KV.Namespace("Cache");
    const usage = yield* Cloudflare.D1.Database("Usage", { migrations: "./migrations" });

    // Key of the keyed `auth_index` (packages/models/src/management/auth-index.ts): 32 random bytes minted on the first
    // deploy of a stage and kept in the (encrypted) stack state, so every later deploy binds the same secret with no
    // manual step. `alchemy dev` (loopback only, no Access) uses a fixed key so local panel links survive a wiped local state.
    const authIndexKey = dev
      ? DEV_AUTH_INDEX_KEY
      : yield* Alchemy.makeRandom("AuthIndexKey", { bytes: 32 });

    // Secrets key (packages/state/src/secrets/): wraps every org's data key, which seals the stored auth files and
    // config entries. Minted like the auth index key, one `Random` per generation: raising SECRETS_KEY_GENERATION mints
    // a new one, and during the rotation the previous generation is bound as SECRETS_KEY_PREVIOUS (docs/DEPLOY.md).
    // Every generation up to the current one stays declared: Alchemy deletes an undeclared resource with its state, and
    // a `Random` exists only there, so an old key must never drop out of the stack. Losing a key loses every secret it
    // still protects.
    const secretsKeys = new Map<number, Effect.Success<ReturnType<typeof Alchemy.makeRandom>>>();

    if (!dev) {
      for (let generation = 1; generation <= settings.secretsKeyGeneration; generation += 1)
        secretsKeys.set(
          generation,
          yield* Alchemy.makeRandom(secretsKeyResourceId(generation), { bytes: 32 }),
        );
    }

    const secretsKey = dev ? DEV_SECRETS_KEY : secretsKeys.get(settings.secretsKeyGeneration);

    const previousSecretsKey =
      settings.secretsKeyPreviousGeneration === undefined
        ? undefined
        : secretsKeys.get(settings.secretsKeyPreviousGeneration);

    // `alchemy dev` serves the Worker on localhost without Access: the dev bypass (packages/auth/src/access/config.ts)
    // makes every loopback request an admin. Deployed Workers never get it and require the Access JWT (or an API key on
    // the client API).
    const { hosted } = settings;

    const access: AccessWiring =
      dev || hosted !== undefined
        ? { aud: "", adminServiceTokens: "", serviceTokenClientIds: {} }
        : yield* provisionAccess(settings);

    // Commissary Cloud (ADR 0026): Better Auth's signing secret, minted like the keys above, and its settings.
    const hostedEnv =
      hosted === undefined
        ? {}
        : {
            COMMISSARY_MODE: "cloud",
            BETTER_AUTH_SECRET: yield* Alchemy.makeRandom("BetterAuthSecret", { bytes: 32 }),
            ...(hosted.githubClientId === ""
              ? {}
              : {
                  SIGN_IN_GITHUB_CLIENT_ID: hosted.githubClientId,
                  SIGN_IN_GITHUB_CLIENT_SECRET: hosted.githubClientSecret,
                }),
            ...(hosted.googleClientId === ""
              ? {}
              : {
                  SIGN_IN_GOOGLE_CLIENT_ID: hosted.googleClientId,
                  SIGN_IN_GOOGLE_CLIENT_SECRET: hosted.googleClientSecret,
                }),
            TURNSTILE_SITE_KEY: hosted.turnstileSiteKey,
            TURNSTILE_SECRET_KEY: hosted.turnstileSecretKey,
            OWNED_ORG_LIMIT: hosted.ownedOrgLimit,
            ORG_RATE_LIMIT: Cloudflare.RateLimit("ORG_RATE_LIMIT", {
              namespaceId: hosted.orgRateLimitNamespaceId,
              simple: { limit: hosted.orgRateLimit, period: 60 },
            }),
          };

    // With an API host (ADR 0028) the Worker answers on both hostnames and serves the client API on the API host only
    // (apps/app/src/http/hosts.ts). The API host has no Access application: clients authenticate there with API keys.
    const split = settings.apiDomain !== "";

    const domain = split
      ? { name: settings.domain, aliases: [settings.apiDomain] }
      : settings.domain;

    // What the state Worker's classes read besides their namespaces and the mode (`StateObjectEnv`, `ModelsPartEnv`).
    // The app Worker's own code reads all of it too, except the secrets keys.
    const stateSettings = {
      // Platform admins seeded as owners of `global`; the Access settings mark a deployed stage, where the dev secrets
      // key is refused (@commissary/state's secrets/).
      ACCESS_TEAM_DOMAIN: dev || hosted !== undefined ? "" : settings.teamDomain,
      ACCESS_AUD: access.aud,
      PLATFORM_ADMIN_EMAILS: settings.adminEmails.join(","),
      PLATFORM_ADMIN_SERVICE_TOKENS: access.adminServiceTokens,
      META_MINT_URL: settings.metaMintUrl,
      // Redacted: bound as a secret (`secret_text`), never as a plain variable.
      AUTH_INDEX_KEY: authIndexKey,
    };

    // The secrets keys (redacted, like `AUTH_INDEX_KEY`): only the ControlPlane reads them, so only the Worker that
    // runs it binds them.
    const secretsKeyBindings = {
      ...(secretsKey === undefined ? {} : { SECRETS_KEY: secretsKey }),
      ...(previousSecretsKey === undefined ? {} : { SECRETS_KEY_PREVIOUS: previousSecretsKey }),
    };

    // The state Worker (apps/state, ADR 0030): defines ControlPlane, SessionState and Platform, and binds only what
    // their classes read (apps/state/src/env.d.ts). No routes, no domain, no workers.dev URL: the other Workers reach
    // it through their Durable Object bindings. A deploy restarts the Durable Objects a Worker defines, and Alchemy
    // uploads a Worker again only when its bundle changes, so they restart only when their own code does.
    //
    // The namespaces used to live in the app Worker (`Commissary`). `transferredFrom` moves each one with every stored
    // object on the first deploy of a stage that still has it there (prod, cloud, a self-hosted stage upgrading); on a
    // fresh stage, or once moved, it does nothing, so it stays (docs/DEPLOY.md, "The state Worker").
    const stateWorker = yield* Cloudflare.Worker("State", {
      main: "./apps/state/src/index.ts",
      compatibility: COMPATIBILITY,
      workersDev: false,
      // Under `alchemy dev` the app Worker keeps the default port 1337, where the panel's dev server sends `/v9`.
      dev: { port: 1338 },
      limits: { cpuMs: settings.cpuMs },
      env: {
        CONTROL_PLANE: Cloudflare.DurableObject("ControlPlane", { transferredFrom: "Commissary" }),
        SESSION_STATE: Cloudflare.DurableObject("SessionState", { transferredFrom: "Commissary" }),
        PLATFORM: Cloudflare.DurableObject("Platform", { transferredFrom: "Commissary" }),
        ...(hosted === undefined ? {} : { COMMISSARY_MODE: "cloud" }),
        ...stateSettings,
        ...secretsKeyBindings,
      },
    });

    // The Durable Objects are the state Worker's, bound by its script name; the binding also makes this Worker deploy
    // after it (ADR 0030: the state Worker deploys before its callers, whose state RPC changes are expand-then-contract,
    // docs/DEVELOPMENT.md).
    //
    // Dev-only guard: under `alchemy dev` the local dev registry reaches another Worker's Durable Object by its hex id
    // and drops `ctx.id.name`, which tells a ControlPlane its org. There, and only there (`dev`), the app runs its dev
    // entry (apps/app/src/dev.ts: the handler plus the state Worker's classes) and binds the objects locally; the state
    // Worker still runs beside it. A deploy always uses apps/app/src/index.ts and the script-name bindings.
    const stateObject = (className: "ControlPlane" | "SessionState" | "Platform") =>
      dev
        ? Cloudflare.DurableObject(className)
        : Cloudflare.DurableObject(className, { scriptName: stateWorker.workerName });

    const worker = yield* Cloudflare.Worker("Commissary", {
      main: dev ? "./apps/app/src/dev.ts" : "./apps/app/src/index.ts",
      compatibility: COMPATIBILITY,
      // Production serves only its Access-protected domain; pull-request previews serve their workers.dev URL,
      // protected by enrolling the Worker into the preview's Access application. The client API leaves Access on both
      // (`provisionClientApiBypass` below, or the API host): clients authenticate there with API keys (ADR 0022).
      workersDev: settings.preview,
      ...(dev || settings.preview ? {} : { domain }),
      ...(access.application === undefined ? {} : { access: access.application }),
      limits: { cpuMs: settings.cpuMs },
      build: { input: { resolve: { alias: { ...BUNDLE_ALIASES } } } },
      // The control panel (`pnpm build`, apps/web). The Worker runs first so the client API is never shadowed by assets
      // and Access gates the panel (apps/app/src/management/web-panel.ts serves it).
      assets: { directory: "./apps/web/dist", runWorkerFirst: true },
      // Previews have no credentials to refresh or catalog worth keeping fresh.
      crons: settings.preview ? [] : CRONS,
      env: {
        CACHE: cache,
        USAGE: usage,
        CONTROL_PLANE: stateObject("ControlPlane"),
        SESSION_STATE: stateObject("SessionState"),
        PLATFORM: stateObject("Platform"),
        ...stateSettings,
        ACCESS_DEV_BYPASS: dev ? settings.devBypass : "",
        ...(split ? { APP_DOMAIN: settings.domain, API_DOMAIN: settings.apiDomain } : {}),
        // Under `alchemy dev` the app runs the ControlPlane itself (the dev-only guard above).
        ...(dev ? secretsKeyBindings : {}),
        ...hostedEnv,
      },
    });

    // The bypass is derived from the Worker's output on every stage, so it is applied only after the Worker: the first
    // deploy must not take the client API out of Access while the old Worker, which only reads the Access edge's
    // `Cf-Access-Jwt-Assertion`, still serves them (clients sending `cf-access-token` would get 401 in between).
    // An API host needs none: Access covers the app host only.
    if (!dev && hosted === undefined && !split)
      yield* provisionClientApiBypass(
        settings,
        Output.asOutput(worker.url).pipe(
          Output.map((url) => {
            if (!settings.preview) return settings.domain;

            // A preview always serves its workers.dev URL (`workersDev` above).
            if (url === undefined) throw new Error("the preview Worker has no workers.dev URL");

            return new URL(url).host;
          }),
        ),
      );

    return {
      url: worker.url,
      // Where clients send API keys: the API host, or the Worker's one URL (tools/deploy-stage.sh).
      apiUrl: split ? `https://${settings.apiDomain}` : worker.url,
      accessAud: access.aud,
      serviceTokens: access.serviceTokenClientIds,
    };
  }),
);
