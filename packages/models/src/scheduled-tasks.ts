/**
 * Models' cron tasks (#134 "Org deletion and crons"), run by the API Worker's cron runner (`apps/api/src/scheduled.ts`) in this order. The
 * services they read besides the bindings come from {@link ScheduledTaskLayer}, which the runner builds once per cron
 * invocation, so the tasks share one config reader and catalog store.
 */
import { Effect, Layer } from "effect";
import type { HttpClient } from "effect/http";
import type { ScheduledTask, WorkerExecutionContext } from "@commissary/core";
import type { StateEnv } from "@commissary/state";
import { ConfigReader } from "./config/reader.ts";
import { refreshAntigravityModels } from "./executor/antigravity/models.ts";
import { refreshAntigravityVersion } from "./executor/antigravity/version.ts";
import { refreshXaiClientVersion } from "./executor/xai/version.ts";
import { runQuotaSweep } from "./quota/check.ts";
import { CatalogStore } from "./registry/catalog-store.ts";
import { refreshCatalogs } from "./registry/refresh.ts";
import { pruneExpiredUsage } from "./usage/retention.ts";
import { currentModelsControlPlane, type ModelsEnv } from "./env.ts";

/** What Models' tasks read: {@link ScheduledTaskLayer} provides the config reader and catalog store, the runner the rest. */
export type ScheduledTaskServices =
  | HttpClient.HttpClient
  | ConfigReader
  | CatalogStore
  | StateEnv
  | ModelsEnv
  | WorkerExecutionContext;

/** The config reader (over the org's ControlPlane) and the catalog store of Models' tasks. */
export const ScheduledTaskLayer = Layer.mergeAll(
  ConfigReader.layerControlPlane(),
  CatalogStore.layer,
);

export const scheduledTasks: ReadonlyArray<ScheduledTask<ScheduledTaskServices>> = [
  // The model catalog (3 h): the models.dev document, trimmed to the providers Commissary reads, into KV. One document
  // feeds every provider's models and the OpenCode gateways (ADR 0020).
  { name: "model-catalog-refresh", scope: "deployment", run: refreshCatalogs },
  // Antigravity client version (Hub updater manifest, KV `antigravity:version`) and per-credential model entitlements
  // (`fetchAvailableModels`, KV `ag:models:<credential>`); the version first so the probes use the fresh user agent.
  { name: "antigravity-version", scope: "deployment", run: refreshAntigravityVersion },
  { name: "antigravity-models", scope: "org", run: refreshAntigravityModels },
  // Usage history older than each org's retention period (on the Platform registry) is deleted from D1 (an org with
  // none keeps everything).
  { name: "usage-retention", scope: "deployment", run: pruneExpiredUsage },
  // helps.StartXAIVersionUpdater (3 h): latest Grok CLI version from npm into KV for the chat-proxy identity headers.
  { name: "xai-client-version-refresh", scope: "deployment", run: refreshXaiClientVersion() },
  // DevinExecutor.Refresh: GetUserStatus profile and quota signals of the (permanent) Devin session tokens.
  {
    name: "devin-user-status",
    scope: "org",
    run: Effect.gen(function* () {
      const plane = yield* currentModelsControlPlane;

      return yield* Effect.promise(() => plane.models().refreshDevinStatus());
    }),
  },
  // Credential refresh safety sweep: re-arms the ControlPlane refresh alarm. Before the quota
  // check, so its token refreshes are done and it does not refresh the same accounts from a second place.
  {
    name: "credential-refresh-sweep",
    scope: "org",
    run: Effect.gen(function* () {
      const plane = yield* currentModelsControlPlane;
      yield* Effect.promise(() => plane.models().sweepRefresh());
    }),
  },
  // Quota check (Workers addition, src/quota): provider usage windows of every enabled account that has a usage
  // endpoint (auth files, and the listed provider keys: OpenCode Go), stored as the credential's `quota_report`.
  // Skipped while the panel's "Check all quotas" holds the sweep lease (`quota_sweep`, `@commissary/state` `lease.ts`).
  { name: "quota-check", scope: "org", run: runQuotaSweep },
];
