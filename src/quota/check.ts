/**
 * One quota check end to end, from the Worker: the ControlPlane resolves the credential and its fresh token
 * (`quotaProbeTarget`), the Worker calls the provider usage endpoint (src/quota/probe.ts) and the ControlPlane merges
 * the outcome into the stored report (`recordQuotaReport`). Used by `POST /v8/management/credentials/quota`, and for
 * every account at once (`sweepQuotas`) by the `quota-check` cron task (`runQuotaSweep`) and the panel's "Check all
 * quotas" (`POST /v8/management/credentials/quota/all`). A sweep holds the ControlPlane's sweep lease
 * (`sweep-lease.ts`), so only one runs at a time whoever started it.
 *
 * The upstream call runs in the Worker rather than inside the Durable Object so the single-writer object is not held
 * by slow provider endpoints and the Worker's injected `HttpClient` (mocked in tests) is used.
 */
import { Clock, Data, Duration, Effect } from "effect";
import type { HttpClient } from "effect/http";
import type { AccountResult, QuotaReport } from "../management/contract/credentials.ts";
import { holdInvocation, WorkerEnv } from "../platform/env.ts";
import { probeQuota } from "./probe.ts";
import type { QuotaOutcome } from "./report.ts";
import type { SweepLease, SweepSource } from "./sweep-lease.ts";

/** A ControlPlane RPC failed (the message never carries payloads). */
export class QuotaControlPlaneError extends Data.TaggedError("QuotaControlPlaneError")<{
  readonly operation: string;
  readonly message: string;
}> {}

export type QuotaCheckResult =
  /** `status`: the upstream HTTP status of a failed check (the report carries the fixed message). */
  | { readonly kind: "checked"; readonly report: QuotaReport; readonly status?: number }
  | { readonly kind: "not_found" }
  | { readonly kind: "unsupported"; readonly provider: string }
  /** The account's tokens changed during the check (a re-login or a token refresh): nothing was stored. */
  | { readonly kind: "stale" };

type Stub = ReturnType<Env["CONTROL_PLANE"]["getByName"]>;

const call = <R>(
  operation: string,
  run: (stub: Stub) => R,
): Effect.Effect<Awaited<R>, QuotaControlPlaneError, WorkerEnv> =>
  Effect.gen(function* () {
    const env = yield* WorkerEnv;

    return yield* Effect.tryPromise({
      // RPC results are promise-pipelining stubs; `await` yields the plain data.
      try: async (): Promise<Awaited<R>> => await run(env.CONTROL_PLANE.getByName("global")),
      catch: (cause) =>
        new QuotaControlPlaneError({
          operation,
          message: cause instanceof Error ? cause.message : "unknown error",
        }),
    });
  });

interface RecordOptions {
  readonly credentialVersion?: number | undefined;
  /** The token of the sweep the check is part of: storing the report renews its lease. */
  readonly sweepLease?: string | undefined;
}

const record = (id: string, outcome: QuotaOutcome, options: RecordOptions) =>
  Effect.gen(function* () {
    const checkedAt = yield* Clock.currentTimeMillis;

    const stored = yield* call("recordQuotaReport", (stub) =>
      stub.recordQuotaReport(id, outcome, checkedAt, {
        ...(options.credentialVersion === undefined
          ? {}
          : { credentialVersion: options.credentialVersion }),
        ...(options.sweepLease === undefined ? {} : { sweepLease: options.sweepLease }),
      }),
    );

    switch (stored.kind) {
      case "stored":
        return outcome.ok || outcome.status === undefined
          ? ({ kind: "checked", report: stored.report } as const)
          : ({ kind: "checked", report: stored.report, status: outcome.status } as const);
      case "gone":
        return { kind: "not_found" } as const;
      case "stale":
        return { kind: "stale" } as const;
    }
  });

/**
 * Checks the quota of the auth file `name` (and/or `authIndex`) and returns the stored report. An outcome for tokens
 * replaced during the check is dropped (`stale`), like a refresh result.
 */
export const checkCredentialQuota = (
  ref: {
    readonly name?: string;
    readonly authIndex?: string;
  },
  options: { readonly sweepLease?: string } = {},
): Effect.Effect<QuotaCheckResult, QuotaControlPlaneError, WorkerEnv | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const target = yield* call("quotaProbeTarget", (stub) => stub.quotaProbeTarget(ref));

    if (target.ok) {
      const outcome = yield* probeQuota(target.target);

      return yield* record(target.target.id, outcome, {
        credentialVersion: target.target.credentialVersion,
        sweepLease: options.sweepLease,
      });
    }

    switch (target.error) {
      case "not_found":
        return { kind: "not_found" } as const;
      case "unsupported":
        return { kind: "unsupported", provider: target.provider } as const;
      case "unavailable":
        return yield* record(
          target.id,
          { ok: false, error: target.message },
          { credentialVersion: target.credentialVersion, sweepLease: options.sweepLease },
        );
    }
  });

/** Provider usage calls a sweep makes at once. */
export const SWEEP_CONCURRENCY = 4;

export type QuotaSweep =
  | {
      readonly kind: "done";
      readonly startedAt: number;
      readonly finishedAt: number;
      /** One per account checked, in the ControlPlane's order. */
      readonly results: ReadonlyArray<AccountResult>;
    }
  /** Another sweep holds the lease. */
  | { readonly kind: "running"; readonly held: SweepLease }
  /**
   * The sweep lost its lease midway (not renewed for its lifetime, so another sweep may have taken it over) and
   * stopped; the reports stored until then stay.
   */
  | { readonly kind: "lost"; readonly startedAt: number };

/** How often a running sweep renews its lease besides each account's report: well within `LEASE_TTL_MS`. */
export const LEASE_RENEW_INTERVAL_MS = 30_000;

/** Renews the sweep's lease after an account whose check stored no report. */
const renew = (token: string) =>
  call("renewQuotaSweepLease", (stub) => stub.renewQuotaSweepLease(token)).pipe(Effect.ignore);

/** One account's outcome as a sweep reports it; a failed check is a result, never a failed sweep. */
const checkForSweep = (token: string) => (id: string) =>
  checkCredentialQuota({ name: id }, { sweepLease: token }).pipe(
    Effect.flatMap((result) => {
      switch (result.kind) {
        case "checked": {
          const { error } = result.report;

          return Effect.succeed<AccountResult>(
            error === undefined
              ? { name: id, ok: true }
              : {
                  name: id,
                  ok: false,
                  error: "check_failed",
                  message: error,
                  ...(result.status === undefined ? {} : { status: result.status }),
                },
          );
        }

        case "stale":
          return Effect.succeed<AccountResult>({
            name: id,
            ok: false,
            error: "stale",
            message: "the account's tokens changed during the check",
          });
        case "not_found":
          return renew(token).pipe(
            Effect.as<AccountResult>({
              name: id,
              ok: false,
              error: "not_found",
              message: "auth file not found",
            }),
          );
        case "unsupported":
          return renew(token).pipe(
            Effect.as<AccountResult>({
              name: id,
              ok: false,
              error: "unsupported",
              message: `quota check is not supported for ${result.provider}`,
            }),
          );
      }
    }),
    Effect.catch((error) =>
      Effect.logWarning(`quota check for ${id} failed: ${error.operation}: ${error.message}`).pipe(
        Effect.andThen(renew(token)),
        Effect.as<AccountResult>({
          name: id,
          ok: false,
          error: "unavailable",
          message: "control plane unavailable",
        }),
      ),
    ),
  );

/**
 * Renews the lease every {@link LEASE_RENEW_INTERVAL_MS} for as long as the sweep runs, since one account's check can
 * outlast the lease (`ensureFresh` up to 120 s plus the probe). Completes only once a renewal says the token no
 * longer holds the lease; a renewal that fails to reach the ControlPlane is retried at the next tick (the lease
 * lifetime covers a few misses).
 */
const keepLease = (token: string): Effect.Effect<void, never, WorkerEnv> =>
  Effect.gen(function* () {
    for (;;) {
      yield* Effect.sleep(Duration.millis(LEASE_RENEW_INTERVAL_MS));

      const held = yield* call("renewQuotaSweepLease", (stub) =>
        stub.renewQuotaSweepLease(token),
      ).pipe(Effect.orElseSucceed(() => true));

      if (!held) return;
    }
  });

/**
 * Checks every enabled auth file of a supported provider, {@link SWEEP_CONCURRENCY} at a time, under the sweep lease:
 * `running` without any provider call when another sweep holds it. Each account's outcome renews the lease, and so
 * does a background renewal every {@link LEASE_RENEW_INTERVAL_MS}; when a renewal finds the lease lost the sweep stops
 * (`lost`). Taking the lease is the acquire step of `acquireUseRelease`, so it is given back however the sweep ends
 * (success, failure, interruption at any point after it was taken), and the invocation is held open
 * (`holdInvocation`, `ctx.waitUntil`) until it is, so a request the client abandoned still gives it back.
 */
export const sweepQuotas = (
  source: SweepSource,
): Effect.Effect<QuotaSweep, QuotaControlPlaneError, WorkerEnv | HttpClient.HttpClient> =>
  Effect.acquireUseRelease(
    // Uninterruptible: the hold and the lease are both registered or neither.
    Effect.gen(function* () {
      const hold = yield* holdInvocation;

      const taken = yield* call("takeQuotaSweepLease", (stub) =>
        stub.takeQuotaSweepLease(source),
      ).pipe(Effect.onError(() => Effect.sync(hold)));

      return { hold, taken };
    }),
    ({ taken }) => {
      if (!taken.ok) return Effect.succeed<QuotaSweep>({ kind: "running", held: taken.held });

      const { token, startedAt } = taken.lease;

      const sweep = Effect.gen(function* () {
        const ids = yield* call("quotaCheckTargets", (stub) => stub.quotaCheckTargets());

        const results = yield* Effect.forEach(ids, checkForSweep(token), {
          concurrency: SWEEP_CONCURRENCY,
        });

        const finishedAt = yield* Clock.currentTimeMillis;

        return { kind: "done", startedAt, finishedAt, results } as const;
      });

      return Effect.raceFirst(
        sweep,
        keepLease(token).pipe(Effect.as<QuotaSweep>({ kind: "lost", startedAt })),
      );
    },
    ({ hold, taken }) =>
      (taken.ok
        ? call("releaseQuotaSweepLease", (stub) =>
            stub.releaseQuotaSweepLease(taken.lease.token),
          ).pipe(Effect.ignore)
        : Effect.void
      ).pipe(Effect.ensuring(Effect.sync(hold))),
  );

export interface QuotaSweepSummary {
  readonly checked: number;
  readonly failed: number;
  /** The run was skipped: another sweep (the panel's) was under way. */
  readonly skipped?: true;
}

/** Cron task `quota-check`: {@link sweepQuotas}, skipped while the panel's sweep runs. */
export const runQuotaSweep: Effect.Effect<
  QuotaSweepSummary,
  QuotaControlPlaneError,
  WorkerEnv | HttpClient.HttpClient
> = Effect.gen(function* () {
  const sweep = yield* sweepQuotas("cron");

  if (sweep.kind === "running") {
    yield* Effect.logInfo(
      `quota check: skipped, a ${sweep.held.source} check started at ${new Date(sweep.held.startedAt).toISOString()} is running`,
    );

    return { checked: 0, failed: 0, skipped: true };
  }

  if (sweep.kind === "lost") {
    yield* Effect.logWarning("quota check: stopped, the sweep lease was lost midway");

    return { checked: 0, failed: 0, skipped: true };
  }

  const checked = sweep.results.filter((result) => result.ok).length;
  const summary = { checked, failed: sweep.results.length - checked };
  yield* Effect.logInfo(`quota check: ${summary.checked} checked, ${summary.failed} failed`);

  return summary;
});
