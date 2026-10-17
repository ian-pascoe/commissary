/**
 * Infrastructure of the Workers port, deployed with Alchemy (`pnpm deploy`, `pnpm dev`, `pnpm destroy`): the three
 * Workers of ADR 0030, the state Worker, which defines the Durable Objects, the app Worker (panel, sign-in, management
 * API) with its static assets, and the API Worker (the client API) with its cron trigger, which both bind the objects by
 * script name; the KV namespace, the D1 usage database (migrations applied on every deploy), the `auth_index` HMAC key
 * and the Cloudflare Access application, policies and service tokens in front of the app (and of the client API on a
 * stage with one host, except that clients send API keys there). Commissary Cloud (`COMMISSARY_MODE=cloud`, ADR 0026)
 * creates no Access resources: the app Worker signs people in itself, and gets its sign-in settings and Better Auth's
 * secret instead, and the API Worker the per-org rate limit.
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
import { CLIENT_API_PREFIXES } from "./packages/core/src/http/client-api.ts";

/**
 * Runtime compatibility of the Workers; keep in sync with apps/app/vitest.config.ts, apps/api/vitest.config.ts,
 * packages/state/vitest.config.ts, packages/models/vitest.config.ts and tools/workers/worker-configuration.d.ts.
 */
export const COMPATIBILITY = { date: "2026-08-01", flags: ["nodejs_compat"] };

/** Model catalog refresh, credential refresh sweep and usage retention (apps/api/src/scheduled.ts). */
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

    // `alchemy dev` serves the Workers on localhost without Access: the dev bypass (packages/auth/src/access/config.ts)
    // makes every loopback request an admin. Deployed Workers never get it and require the Access JWT (or an API key on
    // the client API).
    const { hosted } = settings;

    const access: AccessWiring =
      dev || hosted !== undefined
        ? { aud: "", adminServiceTokens: "", serviceTokenClientIds: {} }
        : yield* provisionAccess(settings);

    // Commissary Cloud (ADR 0026), on the app Worker: Better Auth's signing secret, minted like the keys above, and its
    // settings.
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
          };

    // Commissary Cloud on the API Worker: API keys only, under the per-org rate limit of the client API.
    const hostedApiEnv =
      hosted === undefined
        ? {}
        : {
            COMMISSARY_MODE: "cloud",
            ORG_RATE_LIMIT: Cloudflare.RateLimit("ORG_RATE_LIMIT", {
              namespaceId: hosted.orgRateLimitNamespaceId,
              simple: { limit: hosted.orgRateLimit, period: 60 },
            }),
          };

    // Where the client API is served (ADR 0028, ADR 0030; apps/app/src/http/hosts.ts, apps/api/src/http/hosts.ts): with
    // an API host the API Worker answers there and the app Worker on the app host; without one, zone routes on the app
    // host send the client API paths to the API Worker (a preview's API Worker answers on its own workers.dev URL). The
    // API host has no Access application: clients authenticate there with API keys.
    const split = settings.apiDomain !== "";

    // What the state Worker's classes read besides their namespaces and the mode (`StateObjectEnv`, `ModelsPartEnv`).
    // The app and the API Worker's own code read all of it too, except the secrets keys.
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

    // The Durable Objects are the state Worker's, bound by its script name; the binding also makes the app and the API
    // Worker deploy after it (ADR 0030: the state Worker deploys before its callers, whose state RPC changes are
    // expand-then-contract, docs/DEVELOPMENT.md).
    //
    // Dev-only guard: under `alchemy dev` the local dev registry reaches another Worker's Durable Object by its hex id
    // and drops `ctx.id.name`, which tells a ControlPlane its org (cloudflare/workerd#7286). There, and only there
    // (`dev`), the app runs its dev entry (apps/app/src/dev.ts: the handler plus the state Worker's classes) and binds
    // the objects locally, and the API Worker runs its dev entry (apps/api/src/dev.ts), which reaches those objects over
    // a service binding to the app's dev-only `DevStateBridge` entrypoint; the state Worker still runs beside them. A
    // deploy always uses the `index.ts` entries and the script-name bindings.
    const stateObject = (className: "ControlPlane" | "SessionState" | "Platform") =>
      dev
        ? Cloudflare.DurableObject(className)
        : Cloudflare.DurableObject(className, { scriptName: stateWorker.workerName });

    // The app Worker (apps/app): the panel, sign-in and the management API. Under `alchemy dev` it also runs the Durable
    // Objects and lends them to the API Worker (the dev-only guard above).
    const appWorker = (apiDomain: string | Output.Output<string> | undefined) =>
      Cloudflare.Worker("Commissary", {
        main: dev ? "./apps/app/src/dev.ts" : "./apps/app/src/index.ts",
        compatibility: COMPATIBILITY,
        // Production serves only its Access-protected domain; pull-request previews serve their workers.dev URL,
        // protected by enrolling the Worker into the preview's Access application.
        workersDev: settings.preview,
        ...(dev || settings.preview ? {} : { domain: settings.domain }),
        ...(access.application === undefined ? {} : { access: access.application }),
        limits: { cpuMs: settings.cpuMs },
        build: { input: { resolve: { alias: { ...BUNDLE_ALIASES } } } },
        // The control panel (`pnpm build`, apps/web). The Worker runs first so Access gates the panel
        // (apps/app/src/management/web-panel.ts serves it) and a client API path gets its 404, not an asset.
        assets: { directory: "./apps/web/dist", runWorkerFirst: true },
        env: {
          CACHE: cache,
          USAGE: usage,
          CONTROL_PLANE: stateObject("ControlPlane"),
          SESSION_STATE: stateObject("SessionState"),
          PLATFORM: stateObject("Platform"),
          ...stateSettings,
          ACCESS_DEV_BYPASS: dev ? settings.devBypass : "",
          // Where the panel tells clients to send API keys (`GET /me` `api_url`).
          ...(apiDomain === undefined ? {} : { API_DOMAIN: apiDomain }),
          // Under `alchemy dev` the app runs the ControlPlane itself (the dev-only guard above).
          ...(dev ? secretsKeyBindings : {}),
          ...hostedEnv,
        },
      });

    // The API Worker (apps/api): the client API and the cron jobs. Its own workers.dev URL on a preview, the API host on a
    // stage that has one, else zone routes for the client API paths on the app host (`CLIENT_API_PREFIXES`: a route
    // pattern matches every path that starts with it, as the Workers match them, so `/v1*` covers `/v1beta`). Under
    // `alchemy dev` it serves its own port and reaches the app Worker's objects through the dev-only `DevStateBridge`
    // entrypoint (apps/api/src/dev.ts), bound only there. `app` is the app Worker, deployed first except on a preview.
    const apiWorker = (app: Effect.Success<ReturnType<typeof appWorker>> | undefined) =>
      Cloudflare.Worker("Api", {
        main: dev ? "./apps/api/src/dev.ts" : "./apps/api/src/index.ts",
        compatibility: COMPATIBILITY,
        workersDev: settings.preview,
        ...(dev ? { dev: { port: 1339 } } : {}),
        ...(split ? { domain: settings.apiDomain } : {}),
        ...(dev || settings.preview || split
          ? {}
          : {
              routes: CLIENT_API_PREFIXES.map((prefix) => ({
                pattern: `${settings.domain}${prefix}*`,
              })),
            }),
        limits: { cpuMs: settings.cpuMs },
        // Previews have no credentials to refresh or catalog worth keeping fresh.
        crons: settings.preview ? [] : CRONS,
        env: {
          CACHE: cache,
          USAGE: usage,
          ...(dev && app !== undefined
            ? { DEV_STATE_BRIDGE: Cloudflare.WorkerEntrypoint(app, "DevStateBridge") }
            : {
                CONTROL_PLANE: stateObject("ControlPlane"),
                SESSION_STATE: stateObject("SessionState"),
                PLATFORM: stateObject("Platform"),
              }),
          ...stateSettings,
          ACCESS_DEV_BYPASS: dev ? settings.devBypass : "",
          // Derived from the app Worker's output, so the API host is attached only once the app Worker no longer has it
          // (it was the app's alias before the API Worker existed; Alchemy refuses a hostname another Worker holds).
          ...(split && app !== undefined
            ? {
                APP_DOMAIN: Output.asOutput(app.url).pipe(Output.map(() => settings.domain)),
                API_DOMAIN: settings.apiDomain,
              }
            : {}),
          ...hostedApiEnv,
        },
      });

    // The app Worker comes first: under `alchemy dev` the API Worker binds its bridge, and with an API host the API
    // Worker takes that host from it. On a preview the API Worker comes first: the app names its workers.dev host.
    const { worker, api } = settings.preview
      ? yield* Effect.gen(function* () {
          const client = yield* apiWorker(undefined);

          // A preview always serves its workers.dev URL (`workersDev` above).
          const previewHost = Output.asOutput(client.url).pipe(
            Output.map((url) => {
              if (url === undefined)
                throw new Error("the preview API Worker has no workers.dev URL");

              return new URL(url).host;
            }),
          );

          return { api: client, worker: yield* appWorker(previewHost) };
        })
      : yield* Effect.gen(function* () {
          const app = yield* appWorker(split ? settings.apiDomain : undefined);

          return { worker: app, api: yield* apiWorker(app) };
        });

    // On a stage with one host, the Access application of the app host covers the client API paths the zone routes send
    // to the API Worker; they leave Access (clients send API keys there, ADR 0022). Derived from the API Worker's output,
    // so it is applied only after the API Worker and its routes: the client API must not leave Access while a Worker
    // that only reads the Access edge's `Cf-Access-Jwt-Assertion` still serves it. An API host needs none (Access
    // covers the app host only), nor does a preview, whose API Worker's workers.dev URL is not enrolled in Access.
    if (!dev && hosted === undefined && !split && !settings.preview)
      yield* provisionClientApiBypass(
        settings,
        Output.asOutput(api.url).pipe(Output.map(() => settings.domain)),
      );

    return {
      url: worker.url,
      // Where clients send API keys (tools/deploy-stage.sh): the API host; the API Worker's own URL on a preview or
      // under `alchemy dev`; else the app host, whose client API paths the zone routes send to the API Worker.
      apiUrl: split
        ? `https://${settings.apiDomain}`
        : dev || settings.preview
          ? api.url
          : worker.url,
      accessAud: access.aud,
      serviceTokens: access.serviceTokenClientIds,
    };
  }),
);
