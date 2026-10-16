/**
 * Usage retention cron job (ADR 0027): deletes the usage records older than each org's retention period. An org's period
 * is a number of days in the Platform registry, or none, which keeps its records forever (`global` starts with none; a new org
 * starts with 90 days).
 *
 * Go counterpart: `redis-usage-queue-retention-seconds` bounds the in-process queue (internal/redisqueue/queue.go); D1
 * keeps history, so retention is expressed in days per org and applied by the scheduled handler. The deployment-wide
 * `USAGE_RETENTION_DAYS` variable it replaces is gone: the period belongs to the org.
 */
import { Clock, Effect } from "effect";
import { platform } from "@commissary/state";
import { pruneUsageRecords } from "./d1.ts";
import { ModelsEnv } from "../env.ts";

const DAY_MS = 86_400_000;

/**
 * Deletes each org's records older than its period; returns how many were removed. When the registry cannot be
 * reached nothing is deleted (the failure is the job's), since without it no org's period is known.
 */
export const pruneExpiredUsage = Effect.gen(function* () {
  const env = yield* ModelsEnv;
  const orgs = yield* platform("listOrgs", (stub) => stub.listOrgs());
  const now = yield* Clock.currentTimeMillis;
  let total = 0;

  for (const org of orgs) {
    if (org.usageRetentionDays === null) continue;
    const cutoff = now - org.usageRetentionDays * DAY_MS;
    const removed = yield* Effect.promise(() => pruneUsageRecords(env.USAGE, org.id, cutoff));

    if (removed > 0)
      yield* Effect.logInfo("usage retention").pipe(
        Effect.annotateLogs({ org: org.id, removed, retentionDays: org.usageRetentionDays }),
      );

    total += removed;
  }

  return total;
});
