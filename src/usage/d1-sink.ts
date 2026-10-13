/**
 * `UsageSink` backed by D1 (binding `USAGE`). Writes run in `ctx.waitUntil`, so they never delay or fail a response;
 * a failed write is logged (request id and error message only) and the record is dropped. The record is costed in the
 * same detached write (`UsagePricing`, ADR 0024): a pricing failure never loses the record, which is stored without a
 * cost.
 *
 * Go counterpart: the `usage.Plugin` registered by internal/redisqueue (HandleUsage -> Enqueue).
 */
import { Context, Effect, Layer } from "effect";
import { causeSummary } from "../observability/cause.ts";
import { WorkerEnv, WorkerExecutionContext } from "../platform/env.ts";
import { insertUsageRecord } from "./d1.ts";
import { UsagePricing } from "./pricing-service.ts";
import type { UsageRecord } from "./record.ts";
import { UsageSink } from "./sink.ts";

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Writes `record` and logs (request id and error message only, never the record) instead of failing. */
export const writeUsageRecord = (db: D1Database, record: UsageRecord): Effect.Effect<void> =>
  Effect.tryPromise({ try: () => insertUsageRecord(db, record), catch: errorMessage }).pipe(
    Effect.catch((message) =>
      Effect.logWarning("usage record write failed").pipe(
        Effect.annotateLogs({ requestId: record.requestId, error: message }),
      ),
    ),
  );

/** `record` with its cost; the record as it is when it cannot be costed. */
const costed = (pricing: UsagePricing["Service"], record: UsageRecord) =>
  pricing.costOf(record).pipe(
    Effect.map((cost): UsageRecord => (cost === undefined ? record : { ...record, cost })),
    Effect.catchCause((cause) =>
      Effect.logWarning("usage record pricing failed").pipe(
        Effect.annotateLogs({ requestId: record.requestId, error: causeSummary(cause) }),
        Effect.as(record),
      ),
    ),
  );

/** Needs `UsagePricing` (`UsagePricing.none` stores records without a cost). */
export const D1UsageSink = Layer.effect(
  UsageSink,
  Effect.gen(function* () {
    const pricing = yield* UsagePricing;

    return UsageSink.of({
      publish: (record) =>
        Effect.contextWith((context: Context.Context<never>) => {
          // The bindings are per-request services of the invocation, resolved here and never captured by the layer.
          const env = Context.getOrUndefined(context, WorkerEnv);
          const db = env?.USAGE;

          if (db === undefined) return Effect.void;

          // Runs detached from the response (and possibly after it), keeping the invocation's context (loggers).
          const write = Effect.runPromiseWith(context)(
            costed(pricing, record).pipe(
              Effect.provideService(WorkerEnv, env),
              Effect.flatMap((priced) => writeUsageRecord(db, priced)),
            ),
          );

          const ctx = Context.getOrUndefined(context, WorkerExecutionContext);

          if (ctx !== undefined) {
            try {
              ctx.waitUntil(write);

              return Effect.void;
            } catch {
              // waitUntil is unavailable (invocation already finished): fall through and await the write.
            }
          }

          return Effect.promise(() => write);
        }),
    });
  }),
);
