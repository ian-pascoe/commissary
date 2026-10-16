/**
 * Usage record sink. Records are collected per attempt by `UsageReporter` and handed to the sink once; the production
 * sink (`d1-sink.ts`) persists them to D1 through `ctx.waitUntil`. It reads the per-request `WorkerEnv` and
 * `WorkerExecutionContext` from the fiber context when publishing (never captured in the layer); the requirement is
 * deliberately not part of the type so the conductor's attempt plumbing stays unchanged.
 */
import { Context, Effect, Layer } from "effect";
import type { UsageCost } from "./pricing.ts";
import type { UsageRecord } from "./record.ts";

export class UsageSink extends Context.Service<
  UsageSink,
  {
    /** Must not fail or block the response; implementations defer slow work (e.g. `waitUntil`). */
    readonly publish: (record: UsageRecord) => Effect.Effect<void>;
    /**
     * What `record` cost, for the Spend limits that are charged when the attempt is reported (issue #71); `undefined`
     * when it cannot be costed. Never fails. Records that are not under a Spend limit are priced when they are stored.
     */
    readonly cost: (record: UsageRecord) => Effect.Effect<UsageCost | undefined>;
  }
>()("commissary/usage/UsageSink") {
  /** Drops records. */
  static readonly noop = Layer.succeed(
    UsageSink,
    UsageSink.of({ publish: () => Effect.void, cost: () => Effect.undefined }),
  );

  /**
   * Appends records to `records` (tests). `cost` prices a record for the Spend limits (none by default: records
   * cost nothing).
   */
  static readonly memory = (
    records: Array<UsageRecord>,
    cost: (record: UsageRecord) => UsageCost | undefined = () => undefined,
  ) =>
    Layer.succeed(
      UsageSink,
      UsageSink.of({
        publish: (record) =>
          Effect.sync(() => {
            records.push(record);
          }),
        cost: (record) => Effect.sync(() => cost(record)),
      }),
    );
}

/**
 * `records` with the Cost of each (a record that is costed already keeps its cost) and the total in micro-USD that the
 * Spend limits are charged (`undefined` when nothing cost anything).
 */
export const priceForSpend = (
  sink: UsageSink["Service"],
  records: ReadonlyArray<UsageRecord>,
): Effect.Effect<{
  readonly records: ReadonlyArray<UsageRecord>;
  readonly costMicros: number | undefined;
}> =>
  Effect.gen(function* () {
    const priced: Array<UsageRecord> = [];
    let total = 0;

    for (const record of records) {
      const cost = record.cost ?? (yield* sink.cost(record));

      total += cost?.micros ?? 0;
      priced.push(cost === undefined || record.cost !== undefined ? record : { ...record, cost });
    }

    return { records: priced, costMicros: total > 0 ? total : undefined };
  });
