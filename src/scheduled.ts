/**
 * Cron dispatch (`scheduled` handler). The Worker has a single three-hourly trigger (`CRONS` in alchemy.run.ts); every
 * maintenance job registers itself in `scheduledTasks` so slices add a line instead of editing `index.ts`.
 *
 * Jobs run one after another and are isolated: a failing job is logged and does not stop the others. A job is either
 * deployment-wide (`scope: "deployment"`: the shared model catalog, client versions, usage retention) and runs once, or
 * org-scoped (`scope: "org"`: credentials, quotas, entitlements) and runs once for every org with `CurrentOrg` set, so
 * it only ever reaches that org's ControlPlane (ADR 0021). One org's failure does not stop the next org. The orgs
 * are the ones the Platform registry lists ({@link registeredOrgs}).
 */
import { Clock, Effect, Layer } from "effect";
import { FetchHttpClient, type HttpClient } from "effect/http";
import { ConfigReader } from "./config/reader.ts";
import { refreshAntigravityModels } from "./executor/antigravity/models.ts";
import { refreshAntigravityVersion } from "./executor/antigravity/version.ts";
import { causeSummary } from "./observability/cause.ts";
import { currentControlPlane, WorkerEnv, WorkerExecutionContext } from "./platform/env.ts";
import { CurrentOrg, GLOBAL_ORG, type OrgId } from "./platform/org.ts";
import { platform } from "./platform/registry.ts";
import { runQuotaSweep } from "./quota/check.ts";
import { CatalogStore } from "./registry/catalog-store.ts";
import { refreshXaiClientVersion } from "./executor/xai/version.ts";
import { refreshCatalogs } from "./registry/refresh.ts";
import { pruneExpiredUsage } from "./usage/retention.ts";

/** Services available to scheduled jobs (provided by {@link ScheduledLayer} and the invocation's bindings). */
export type ScheduledServices =
  | HttpClient.HttpClient
  | ConfigReader
  | CatalogStore
  | WorkerEnv
  | WorkerExecutionContext;

export type ScheduledTask =
  | {
      readonly name: string;
      readonly scope: "deployment";
      readonly run: Effect.Effect<unknown, Error, ScheduledServices>;
    }
  | {
      readonly name: string;
      readonly scope: "org";
      readonly run: Effect.Effect<unknown, Error, ScheduledServices | CurrentOrg>;
    };

export const scheduledTasks: ReadonlyArray<ScheduledTask> = [
  // The model catalog (3 h): the models.dev document, trimmed to the providers the proxy reads, into KV. One document
  // feeds every provider's models and the OpenCode gateways (ADR 0020).
  { name: "model-catalog-refresh", scope: "deployment", run: refreshCatalogs },
  // Antigravity client version (Hub updater manifest, KV `antigravity:version`) and per-credential model entitlements
  // (`fetchAvailableModels`, KV `ag:models:<credential>`); the version first so the probes use the fresh user agent.
  { name: "antigravity-version", scope: "deployment", run: refreshAntigravityVersion },
  { name: "antigravity-models", scope: "org", run: refreshAntigravityModels },
  // Usage history older than each org's retention period is deleted from D1 (an org with none keeps everything).
  { name: "usage-retention", scope: "deployment", run: pruneExpiredUsage },
  // helps.StartXAIVersionUpdater (3 h): latest Grok CLI version from npm into KV for the chat-proxy identity headers.
  { name: "xai-client-version-refresh", scope: "deployment", run: refreshXaiClientVersion() },
  // DevinExecutor.Refresh: GetUserStatus profile and quota signals of the (permanent) Devin session tokens.
  {
    name: "devin-user-status",
    scope: "org",
    run: Effect.gen(function* () {
      const plane = yield* currentControlPlane;

      return yield* Effect.promise(() => plane.refreshDevinStatus());
    }),
  },
  // Expired proxy keys are deleted, not kept marked (ADR 0027): a listing or issue deletes them too, this covers an org
  // nobody opens.
  {
    name: "proxy-key-expiry",
    scope: "org",
    run: Effect.gen(function* () {
      const plane = yield* currentControlPlane;
      const now = yield* Clock.currentTimeMillis;

      return yield* Effect.promise(() => plane.purgeExpiredProxyKeys(now));
    }),
  },
  // Credential refresh safety sweep: re-arms the ControlPlane refresh alarm. Before the quota
  // check, so its token refreshes are done and it does not refresh the same accounts from a second place.
  {
    name: "credential-refresh-sweep",
    scope: "org",
    run: Effect.gen(function* () {
      const plane = yield* currentControlPlane;
      yield* Effect.promise(() => plane.sweepRefresh());
    }),
  },
  // Quota check (Workers addition, src/quota): provider usage windows of every enabled account that has a usage
  // endpoint (auth files, and the listed config provider keys: OpenCode Go), stored as the credential's `quota_report`.
  // Skipped while the panel's "Check all quotas" holds the sweep lease (src/quota/sweep-lease.ts).
  { name: "quota-check", scope: "org", run: runQuotaSweep },
];

export const ScheduledLayer = Layer.mergeAll(
  FetchHttpClient.layer,
  ConfigReader.layerControlPlane(),
  CatalogStore.layer,
);

/** Logs a failed job instead of failing the invocation; a summary only: full causes carry stacks and upstream URLs. */
const isolated = <R>(
  label: string,
  run: Effect.Effect<unknown, Error, R>,
): Effect.Effect<void, never, R> =>
  run.pipe(
    Effect.asVoid,
    Effect.catchCause((cause) =>
      Effect.logError(`scheduled task ${label} failed: ${causeSummary(cause)}`),
    ),
  );

/**
 * The ids of the orgs the Platform registry lists, in its order. When the registry cannot be reached the jobs still run
 * for `global`, the org every deployment has had since before orgs existed, so one failing object does not stop the
 * deployment's maintenance; the failure is logged.
 */
export const registeredOrgs: Effect.Effect<ReadonlyArray<OrgId>, never, WorkerEnv> = platform(
  "listOrgs",
  (stub) => stub.listOrgs(),
).pipe(
  Effect.map((orgs) => orgs.map((org) => org.id)),
  Effect.catchTag("PlatformUnavailable", (error) =>
    Effect.logError(
      `scheduled tasks: ${error.message}; running the org jobs for ${GLOBAL_ORG} only`,
    ).pipe(Effect.as([GLOBAL_ORG])),
  ),
);

/**
 * Runs all jobs for one cron invocation: deployment jobs once, org jobs once per org of `orgs` (the registry's orgs
 * unless given), in task order.
 */
export const runScheduledTasks = (
  tasks: ReadonlyArray<ScheduledTask>,
  env: Env,
  ctx: ExecutionContext,
  orgs?: ReadonlyArray<OrgId>,
): Promise<void> =>
  Effect.gen(function* () {
    const targets = orgs ?? (yield* registeredOrgs);

    yield* Effect.forEach(
      tasks,
      (task) =>
        task.scope === "deployment"
          ? isolated(task.name, task.run)
          : Effect.forEach(
              targets,
              (org) =>
                isolated(`${task.name} (org ${org})`, task.run).pipe(
                  Effect.provideService(CurrentOrg, org),
                ),
              { discard: true },
            ),
      { discard: true },
    );
  }).pipe(
    Effect.provide(ScheduledLayer),
    Effect.provideService(WorkerEnv, env),
    Effect.provideService(WorkerExecutionContext, ctx),
    Effect.runPromise,
  );

export const dispatchScheduled = (
  _controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> => runScheduledTasks(scheduledTasks, env, ctx);
