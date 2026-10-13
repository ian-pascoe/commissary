/**
 * Infrastructure of the Workers port, deployed with Alchemy (`pnpm deploy`, `pnpm dev`, `pnpm destroy`): the Worker
 * with its Durable Objects, static assets and cron trigger, the KV namespace, the D1 usage database (migrations
 * applied on every deploy), the `auth_index` HMAC key and the Cloudflare Access application, policies and service tokens
 * in front of it (except the proxy routes, where clients send proxy keys).
 * Deploy-time settings are read from the environment / `.env` (see `.env.example` and infra/settings.ts).
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Output from "alchemy/Output";
import { type AccessWiring, provisionAccess, provisionProxyBypass } from "./infra/access.ts";
import { readSettings } from "./infra/settings.ts";
import { DEV_AUTH_INDEX_KEY } from "./src/management/auth-index-key.ts";
import { DEV_SECRETS_KEY, secretsKeyResourceId } from "./src/secrets/key.ts";

/** Runtime compatibility of the Worker; keep in sync with vitest.config.ts and worker-configuration.d.ts. */
export const COMPATIBILITY = { date: "2026-08-01", flags: ["nodejs_compat"] };

/** Model catalog refresh, credential refresh sweep and usage retention (src/scheduled.ts). */
export const CRONS = ["0 */3 * * *"];

// Remote state in the account (`Cloudflare.state()`, shared by every machine and CI) unless ALCHEMY_STATE=local,
// which keeps it under .alchemy/ (handy for `alchemy dev` without a Cloudflare login).
const state = process.env["ALCHEMY_STATE"] === "local" ? Alchemy.localState() : Cloudflare.state();

export default Alchemy.Stack(
  "cf-llm-proxy",
  { providers: Cloudflare.providers(), state },
  Effect.gen(function* () {
    const dev = yield* Alchemy.ALCHEMY_DEV;
    const settings = yield* readSettings(dev, yield* Alchemy.Stage);

    const cache = yield* Cloudflare.KV.Namespace("Cache");
    const usage = yield* Cloudflare.D1.Database("Usage", { migrations: "./migrations" });

    // Key of the keyed `auth_index` (src/management/auth-index.ts): 32 random bytes minted on the first deploy of a
    // stage and kept in the (encrypted) stack state, so every later deploy binds the same secret with no manual step.
    // `alchemy dev` (loopback only, no Access) uses a fixed key so local panel links survive a wiped local state.
    const authIndexKey = dev
      ? DEV_AUTH_INDEX_KEY
      : yield* Alchemy.makeRandom("AuthIndexKey", { bytes: 32 });

    // Secrets key (src/secrets/): wraps every org's data key, which seals the stored auth files and config entries. Minted
    // like the auth index key, one `Random` per generation: raising SECRETS_KEY_GENERATION mints a new one, and during
    // the rotation the previous generation is bound as SECRETS_KEY_PREVIOUS (docs/DEPLOY.md). Every generation up to the
    // current one stays declared: Alchemy deletes an undeclared resource with its state, and a `Random` exists only
    // there, so an old key must never drop out of the stack. Losing a key loses every secret it still protects.
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

    // `alchemy dev` serves the Worker on localhost without Access: the dev bypass (src/access/config.ts) makes every
    // loopback request an admin. Deployed Workers never get it and require the Access JWT (or a proxy key on the proxy
    // routes).
    const access: AccessWiring = dev
      ? { aud: "", adminServiceTokens: "", serviceTokenClientIds: {} }
      : yield* provisionAccess(settings);

    const worker = yield* Cloudflare.Worker("Proxy", {
      main: "./src/index.ts",
      compatibility: COMPATIBILITY,
      // Production serves only its Access-protected domain; pull-request previews serve their workers.dev URL,
      // protected by enrolling the Worker into the preview's Access application. The proxy routes leave Access on both
      // (`provisionProxyBypass` below): clients authenticate there with proxy keys (ADR 0022).
      workersDev: settings.preview,
      ...(dev || settings.preview ? {} : { domain: settings.domain }),
      ...(access.application === undefined ? {} : { access: access.application }),
      limits: { cpuMs: settings.cpuMs },
      // The control panel (`pnpm web:build`). The Worker runs first so proxy routes are never shadowed by assets and
      // Access gates the panel (src/management/web-panel.ts serves it).
      assets: { directory: "./public", runWorkerFirst: true },
      // Previews have no credentials to refresh or catalog worth keeping fresh.
      crons: settings.preview ? [] : CRONS,
      env: {
        CACHE: cache,
        USAGE: usage,
        CONTROL_PLANE: Cloudflare.DurableObject("ControlPlane"),
        SESSION_STATE: Cloudflare.DurableObject("SessionState"),
        PLATFORM: Cloudflare.DurableObject("Platform"),
        ACCESS_TEAM_DOMAIN: dev ? "" : settings.teamDomain,
        ACCESS_AUD: access.aud,
        PLATFORM_ADMIN_EMAILS: settings.adminEmails.join(","),
        PLATFORM_ADMIN_SERVICE_TOKENS: access.adminServiceTokens,
        ACCESS_DEV_BYPASS: dev ? settings.devBypass : "",
        USAGE_RETENTION_DAYS: settings.usageRetentionDays,
        META_MINT_URL: settings.metaMintUrl,
        // Redacted: bound as a secret (`secret_text`), never as a plain variable.
        AUTH_INDEX_KEY: authIndexKey,
        ...(secretsKey === undefined ? {} : { SECRETS_KEY: secretsKey }),
        ...(previousSecretsKey === undefined ? {} : { SECRETS_KEY_PREVIOUS: previousSecretsKey }),
      },
    });

    // The bypass is derived from the Worker's output on every stage, so it is applied only after the Worker: the first
    // deploy must not take the proxy routes out of Access while the old Worker, which only reads the Access edge's
    // `Cf-Access-Jwt-Assertion`, still serves them (clients sending `cf-access-token` would get 401 in between).
    if (!dev)
      yield* provisionProxyBypass(
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
      accessAud: access.aud,
      serviceTokens: access.serviceTokenClientIds,
    };
  }),
);
