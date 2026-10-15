/**
 * `POST /v9/management/credentials/quota` (`checkQuota` in contract/credentials.ts): checks one account's allowance
 * at the provider's usage endpoint now and answers with the stored report. The account is an auth file (by file name)
 * or a listed config provider key (OpenCode Go, by the `auth_index` the list names it with).
 *
 * `POST /v9/management/credentials/quota/all` (`checkAllQuotas`): the panel's "Check all quotas", the cron task's
 * sweep run now (`sweepQuotas`: every enabled auth file and listed config key of a supported provider,
 * `SWEEP_CONCURRENCY` accounts at a time, recent Claude reset grant reads skipped).
 * Answers `200 {started_at, finished_at, results, checked, failed}` with each account's outcome (a failed check is
 * `ok: false` with the report's fixed error message and the upstream status). Deduplicated through the ControlPlane's
 * sweep lease (src/quota/sweep-lease.ts): while another sweep runs, the panel's or the scheduled one, it answers `409
 * quota_check_running` (with `message` naming who started it and when) and asks no provider; the running sweep's
 * reports land in the credential list as they are stored.
 *
 * Workers addition, no Go counterpart: the upstream panel calls the usage endpoints from the browser through Go's
 * `POST /requests/api-call`, which is not ported (see docs/ARCHITECTURE.md "Quota check"). Tokens never leave the
 * server; an upstream failure is a 200 whose report carries `error` (and keeps the last successful windows). A check
 * whose account's tokens changed meanwhile (a re-login or a token refresh) stores nothing and answers `409 stale`. A
 * sweep that lost its lease midway (not renewed for its lifetime) stops and answers `409 quota_check_lost`.
 */
import { Effect } from "effect";
import type { Json } from "../json/index.ts";
import { checkCredentialQuota, sweepQuotas } from "../quota/check.ts";
import { bodyObject, handled, jsonReply, replyError } from "./http.ts";
import { currentViewer } from "./viewer.ts";

const text = (value: Json | undefined): string => (typeof value === "string" ? value.trim() : "");

const checkQuota = Effect.gen(function* () {
  const body = yield* bodyObject;
  const name = text(body.name);
  const authIndex = text(body.auth_index);

  if (name === "") return yield* replyError(400, "name is required");

  const viewer = yield* currentViewer;

  const result = yield* checkCredentialQuota(
    {
      name,
      ...(authIndex === "" ? {} : { authIndex }),
    },
    { viewer },
  ).pipe(
    Effect.catchTag("QuotaControlPlaneError", (error) =>
      Effect.logError(`management ${error.operation} failed: ${error.message}`).pipe(
        Effect.andThen(Effect.fail(replyError(502, "control plane unavailable"))),
      ),
    ),
  );

  switch (result.kind) {
    case "checked":
      return jsonReply(200, { status: "ok", report: result.report });
    case "not_found":
      return yield* replyError(404, "auth file not found");
    case "unsupported":
      return yield* replyError(422, `quota check is not supported for ${result.provider}`);
    case "stale":
      return yield* replyError(409, "stale", {
        message: "the account's tokens changed during the check; check again",
      });
  }
});

const iso = (ms: number): string => new Date(ms).toISOString();

const checkAllQuotas = Effect.gen(function* () {
  // The caller's own accounts: an org admin's check never reaches a private credential.
  const viewer = yield* currentViewer;

  const sweep = yield* sweepQuotas("panel", viewer).pipe(
    Effect.catchTag("QuotaControlPlaneError", (error) =>
      Effect.logError(`management ${error.operation} failed: ${error.message}`).pipe(
        Effect.andThen(Effect.fail(replyError(502, "control plane unavailable"))),
      ),
    ),
  );

  if (sweep.kind === "running") {
    const by = sweep.held.source === "cron" ? "the scheduled check" : "the panel";

    return yield* replyError(409, "quota_check_running", {
      message: `a check of every quota started by ${by} at ${iso(sweep.held.startedAt)} is still running`,
    });
  }

  if (sweep.kind === "lost") {
    return yield* replyError(409, "quota_check_lost", {
      message:
        "the check stopped: it could not keep its lease, so another check may have taken over; the figures stored so far stay",
    });
  }

  const checked = sweep.results.filter((result) => result.ok).length;

  return jsonReply(200, {
    started_at: iso(sweep.startedAt),
    finished_at: iso(sweep.finishedAt),
    results: sweep.results,
    checked,
    failed: sweep.results.length - checked,
  });
});

/** Needs an `HttpClient` (bound in `routes.ts`). */
export const quotaCheckHandler = handled(checkQuota);

/** Needs an `HttpClient` (bound in `routes.ts`). */
export const quotaSweepHandler = handled(checkAllQuotas);
