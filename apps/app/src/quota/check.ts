/**
 * One quota check end to end, from the Worker: the ControlPlane resolves the credential and its fresh token
 * (`quotaProbeTarget`), the Worker calls the provider usage endpoint (src/quota/probe.ts) and the ControlPlane merges
 * the outcome into the stored report (`recordQuotaReport`). Used by `POST /v9/management/credentials/quota`, and for
 * every account at once (`sweepQuotas`) by the `quota-check` cron task (`runQuotaSweep`) and the panel's "Check all
 * quotas" (`POST /v9/management/credentials/quota/all`). A sweep holds the ControlPlane's `quota_sweep` lease
 * (src/state/lease.ts), so only one runs at a time whoever started it: a second sweep is refused (the panel answers
 * `409 quota_check_running`, the cron task skips its run) instead of asking every provider a second time. There is no
 * rate limit beyond that: a sweep started right after another one finished checks again. Accounts are named as the
 * credential list names them: auth files by file name, provider keys of a provider that reports quota with the key
 * (OpenCode Go) by their `auth_index`; a sweep covers both (`quotaCheckTargets`).
 *
 * The upstream call runs in the Worker rather than inside the Durable Object so the single-writer object is not held
 * by slow provider endpoints and the Worker's injected `HttpClient` (mocked in tests) is used.
 */
import { Clock, Data, Duration, Effect } from "effect";
import type { HttpClient } from "effect/http";
import { FULL_ACCESS, type Scope } from "../credentials/ownership.ts";
import type { AccountResult, QuotaReport } from "@commissary/contract/credentials";
import { holdInvocation, type CurrentOrg } from "@commissary/core";
import { probeQuota } from "./probe.ts";
import type { QuotaOutcome } from "./report.ts";
import type { ResetGrantMark } from "./reset-grant-store.ts";
import type { LeaseSource, NamedLease } from "../state/lease.ts";
import {
  currentModelsControlPlane,
  type ModelsControlPlaneStub,
  type ModelsEnv,
} from "../models/env.ts";

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

/** One RPC to the current org's ControlPlane (also used by `reset-grant-flow.ts`). */
export const call = <R>(
  operation: string,
  run: (stub: ModelsControlPlaneStub) => R,
): Effect.Effect<Awaited<R>, QuotaControlPlaneError, ModelsEnv | CurrentOrg> =>
  Effect.gen(function* () {
    const stub = yield* currentModelsControlPlane;

    return yield* Effect.tryPromise({
      // RPC results are promise-pipelining stubs; `await` yields the plain data.
      try: async (): Promise<Awaited<R>> => await run(stub),
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
  /** Claude: the reset grant state the probe's grant read is based on (`reset-grant-store.ts`). */
  readonly grantsMark?: ResetGrantMark | undefined;
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
        ...(options.grantsMark === undefined ? {} : { grantsMark: options.grantsMark }),
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
 * Checks the quota of the account `name` (an auth file name, or a listed provider key's `auth_index`) and/or
 * `authIndex` and returns the stored report. An outcome for tokens
 * replaced during the check is dropped (`stale`), like a refresh result. `sweep`: part of a sweep, which skips
 * recent Claude reset grant reads (`quotaProbeTarget`).
 */
export const checkCredentialQuota = (
  ref: {
    readonly name?: string;
    readonly authIndex?: string;
  },
  options: {
    readonly sweepLease?: string;
    readonly sweep?: boolean;
    /** Who asks: only an account they manage in full is checked (`FULL_ACCESS`: the cron sweep, every account). */
    readonly viewer: Scope;
  },
): Effect.Effect<
  QuotaCheckResult,
  QuotaControlPlaneError,
  ModelsEnv | CurrentOrg | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const target = yield* call("quotaProbeTarget", (stub) =>
      stub.quotaProbeTarget(ref, { sweep: options.sweep === true }, options.viewer),
    );

    if (target.ok) {
      const outcome = yield* probeQuota(target.target);

      return yield* record(target.target.id, outcome, {
        credentialVersion: target.target.credentialVersion,
        sweepLease: options.sweepLease,
        grantsMark: target.grantsMark,
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

/**
 * Accounts a sweep checks at once. A Claude check opens up to three upstream connections at once (usage, profile,
 * reset grants), so two checks stay within the six simultaneous connections a Workers invocation may have waiting for
 * headers (more are queued, and could run into the probe's 15 s bound). Subrequests per Claude account: three upstream
 * fetches (two when the grant read is skipped) plus two ControlPlane RPCs; see docs/ARCHITECTURE.md "Quota check" for
 * the plan limits.
 */
export const SWEEP_CONCURRENCY = 2;

export type QuotaSweep =
  | {
      readonly kind: "done";
      readonly startedAt: number;
      readonly finishedAt: number;
      /** One per account checked, in the ControlPlane's order. */
      readonly results: ReadonlyArray<AccountResult>;
    }
  /** Another sweep holds the lease. */
  | { readonly kind: "running"; readonly held: NamedLease }
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
const checkForSweep = (token: string, viewer: Scope) => (id: string) =>
  checkCredentialQuota({ name: id }, { sweepLease: token, sweep: true, viewer }).pipe(
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
              message: "account not found",
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
const keepLease = (token: string): Effect.Effect<void, never, ModelsEnv | CurrentOrg> =>
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
 * Checks every enabled account of a supported provider (auth files and the listed provider keys),
 * {@link SWEEP_CONCURRENCY} at a time, under the sweep lease:
 * `running` without any provider call when another sweep holds it. Each account's outcome renews the lease, and so
 * does a background renewal every {@link LEASE_RENEW_INTERVAL_MS}; when a renewal finds the lease lost the sweep stops
 * (`lost`). Taking the lease is the acquire step of `acquireUseRelease`, so it is given back however the sweep ends
 * (success, failure, interruption at any point after it was taken), and the invocation is held open
 * (`holdInvocation`, `ctx.waitUntil`) until it is, so a request the client abandoned still gives it back.
 */
export const sweepQuotas = (
  source: LeaseSource,
  viewer: Scope,
): Effect.Effect<
  QuotaSweep,
  QuotaControlPlaneError,
  ModelsEnv | CurrentOrg | HttpClient.HttpClient
> =>
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
        const ids = yield* call("quotaCheckTargets", (stub) => stub.quotaCheckTargets(viewer));

        const results = yield* Effect.forEach(ids, checkForSweep(token, viewer), {
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
  ModelsEnv | CurrentOrg | HttpClient.HttpClient
> = Effect.gen(function* () {
  const sweep = yield* sweepQuotas("cron", FULL_ACCESS);

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
