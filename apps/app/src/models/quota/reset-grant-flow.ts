/**
 * Reading and claiming Claude reset grants end to end, from the Worker (`GET`/`POST
 * /v9/management/credentials/reset-grants`): the ControlPlane resolves the account, its fresh token and the grant
 * `mark` (`resetGrantTarget`) and serializes claims (`beginResetGrantClaim`/`settleResetGrantClaim`); the Worker makes
 * the upstream calls (src/models/quota/reset-grants.ts) with its injected `HttpClient`, like the quota check (`check.ts`).
 *
 * Every claim reads the status first. A fresh claim spends the grant that read picked and sends nothing when none is
 * claimable (`none_available`); the ControlPlane refuses to start it when a claim started or was answered after the
 * mark was handed out, since the read may predate that reset (`stale`, "check resets and try again"). A claim left
 * unanswered is resent with the same grant and request id within its retry window; when the status read shows that it
 * landed (`claimLanded`) it is closed without sending, as spent only when that read shows the account no longer at a
 * limit (`not_confirmed` otherwise, `landedAnswer`: the claim stays open and the next resend sends), and a failing
 * read does not block the resend.
 * Disabled accounts cannot claim (reads stay allowed). After a spent reset the account's cooldowns are cleared and its
 * quota is checked again, so the panel shows the cleared windows. When the answer cannot be recorded, the outcome is
 * still returned, with a warning.
 *
 * Upstream calls are bounded (12 s reads, 25 s claim; panel bounds) and never follow redirects (a 3xx is a failed
 * read or an unknown claim outcome). Failures carry fixed messages: bodies and tokens are never logged or returned.
 */
import { Clock, Effect, Result } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { type Json, tryParseJson } from "@commissary/json";
import type {
  PendingResetClaim,
  QuotaReport,
  ResetGrantOutcome,
  ResetGrantStatus,
} from "@commissary/contract/credentials";
import type { Scope } from "../credentials/ownership.ts";
import type { CurrentOrg } from "@commissary/core";
import { call, checkCredentialQuota, type QuotaControlPlaneError } from "./check.ts";
import type { ResetGrantMark } from "./reset-grant-store.ts";
import { CLAUDE_HEADERS, CLAUDE_PROFILE_URL } from "./claude.ts";
import {
  CLAIM_TIMEOUT,
  type ClaimAnswer,
  claimAnswer,
  claimBody,
  claimLanded,
  type FreshClaim,
  landedAnswer,
  parseOrganization,
  parseResetGrantStatus,
  RESET_GRANT_STATUS_URL,
  resetGrantClaimUrl,
} from "./reset-grants.ts";
import type { ModelsEnv } from "../env.ts";

const READ_TIMEOUT = "12 seconds";

interface Answer {
  readonly status: number;
  readonly body: Json | undefined;
}

/** One upstream call; `undefined` on a transport error or timeout. Redirects are not followed. */
const send = (
  request: HttpClientRequest.HttpClientRequest,
  timeout: typeof READ_TIMEOUT | typeof CLAIM_TIMEOUT,
): Effect.Effect<Answer | undefined, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(request);
    const text = yield* response.text;

    return { status: response.status, body: tryParseJson(text) };
  }).pipe(
    Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.succeed(undefined) }),
    Effect.orElseSucceed(() => undefined),
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    Effect.provideService(HttpClient.TracerPropagationEnabled, false),
  );

const headers = (token: string) => ({ ...CLAUDE_HEADERS, authorization: `Bearer ${token}` });

const read = (url: string, token: string) =>
  send(
    HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(headers(token))),
    READ_TIMEOUT,
  ).pipe(
    Effect.map((answer) =>
      answer !== undefined && answer.status >= 200 && answer.status < 300 ? answer.body : undefined,
    ),
  );

/**
 * The account's grant status now, dated by when the read started; `undefined` when the read failed or the answer is
 * malformed.
 */
const readStatus = (token: string) =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    const body = yield* read(RESET_GRANT_STATUS_URL, token);

    return body === undefined ? undefined : parseResetGrantStatus(body, startedAt);
  });

/** Failures shared by both operations. */
export type ResetGrantFailure =
  | { readonly kind: "not_found" }
  | { readonly kind: "unsupported"; readonly provider: string }
  | { readonly kind: "unavailable"; readonly message: string }
  | { readonly kind: "conflict"; readonly message: string };

export type ResetGrantReadResult =
  | {
      readonly kind: "read";
      readonly grants: ResetGrantStatus;
      readonly pending?: PendingResetClaim;
    }
  | ResetGrantFailure;

export type ResetGrantClaimResult =
  | {
      readonly kind: "claimed";
      readonly outcome: ResetGrantOutcome;
      readonly retried: boolean;
      readonly cooldownCleared: boolean;
      readonly grants?: ResetGrantStatus;
      readonly report?: QuotaReport;
      readonly pending?: PendingResetClaim;
      readonly warning?: string;
    }
  | ResetGrantFailure;

type Ref = { readonly authIndex: string };

type Requirements = ModelsEnv | CurrentOrg | HttpClient.HttpClient;

const STATUS_FAILED = "could not read the reset grants from Anthropic";

const CONFLICTS = {
  busy: "another reset of this Anthropic account is being used or awaits an answer, possibly from another auth file; check resets",
  busy_removed:
    "a reset sent from a removed auth file of this Anthropic account still awaits an answer; it frees itself within 10 minutes of being sent, then check resets",
  identity: "the unanswered reset was sent for another organization",
  expired: "the unanswered reset can no longer be resent; check resets and try again",
  settled: "the unanswered reset was already answered in another tab; check resets",
  stale: "the resets changed while they were being read; check resets and try again",
  changed: "the account was replaced while its resets were being read; check resets again",
  disabled: "this account is disabled; enable it to use a reset",
} as const;

const SETTLE_FAILED =
  "Anthropic answered, but Commissary could not record the answer; check resets before trying again";

const target = (ref: Ref, viewer: Scope) =>
  Effect.map(
    call("resetGrantTarget", (stub) => stub.models().resetGrantTarget(ref, viewer)),
    (result) => {
      if (result.ok) return result;

      switch (result.error) {
        case "not_found":
          return { kind: "not_found" } as const;
        case "unsupported":
          return { kind: "unsupported", provider: result.provider } as const;
        case "unavailable":
          return { kind: "unavailable", message: result.message } as const;
      }
    },
  );

/** Reads a status and stores it under `mark`; the status (`undefined` when the read failed) and how it was stored. */
const refreshStatus = (id: string, token: string, mark: ResetGrantMark) =>
  Effect.gen(function* () {
    const grants = yield* readStatus(token);

    if (grants === undefined) return { grants, stored: undefined };

    const stored = yield* call("recordResetGrantStatus", (stub) =>
      stub.models().recordResetGrantStatus(id, grants, mark),
    );

    return { grants, stored };
  });

/** `GET /credentials/reset-grants`: the account's status read now (and stored). */
export const readResetGrants = (
  ref: Ref,
  viewer: Scope,
): Effect.Effect<ResetGrantReadResult, QuotaControlPlaneError, Requirements> =>
  Effect.gen(function* () {
    const resolved = yield* target(ref, viewer);

    if (!("ok" in resolved)) return resolved;
    const { grants, stored } = yield* refreshStatus(resolved.id, resolved.token, resolved.mark);

    if (grants === undefined) return { kind: "unavailable", message: STATUS_FAILED } as const;

    if (stored === "gone") return { kind: "not_found" } as const;

    if (stored === "replaced") return { kind: "conflict", message: CONFLICTS.changed } as const;

    return {
      kind: "read",
      grants,
      ...(resolved.pending === undefined ? {} : { pending: resolved.pending }),
    } as const;
  });

/** `POST /credentials/reset-grants/claim`: spends one reset of the account (see the module header). */
export const claimResetGrant = (
  ref: Ref,
  viewer: Scope,
): Effect.Effect<ResetGrantClaimResult, QuotaControlPlaneError, Requirements> =>
  Effect.gen(function* () {
    const resolved = yield* target(ref, viewer);

    if (!("ok" in resolved)) return resolved;
    const { id, token, mark, pending } = resolved;

    if (resolved.disabled) return { kind: "conflict", message: CONFLICTS.disabled } as const;

    if (pending?.in_flight === true) return { kind: "conflict", message: CONFLICTS.busy } as const;
    const { grants, stored } = yield* refreshStatus(id, token, mark);

    if (stored === "gone") return { kind: "not_found" } as const;

    if (stored === "replaced") return { kind: "conflict", message: CONFLICTS.changed } as const;
    let fresh: FreshClaim | undefined;

    // A resend needs no status: a read failing then must not block it.
    if (pending === undefined) {
      if (grants === undefined) return { kind: "unavailable", message: STATUS_FAILED } as const;

      if (grants.claimable === undefined)
        return {
          kind: "claimed",
          outcome: "none_available",
          retried: false,
          cooldownCleared: false,
          grants,
        } as const;
      const chosen = grants.grants.find((grant) => grant.id === grants.claimable);

      fresh = {
        grantId: grants.claimable,
        requestId: crypto.randomUUID(),
        ...(chosen === undefined ? {} : { resetsLeft: chosen.resets_left }),
      };
    }

    const organization = parseOrganization(yield* read(CLAUDE_PROFILE_URL, token));

    if (organization === undefined)
      return {
        kind: "unavailable",
        message: "could not read the account's organization from Anthropic",
      } as const;

    const begun = yield* call("beginResetGrantClaim", (stub) =>
      stub.models().beginResetGrantClaim(id, organization, fresh, mark, resolved.pendingRequestId),
    );

    if (!begun.ok)
      return begun.error === "not_found"
        ? ({ kind: "not_found" } as const)
        : ({ kind: "conflict", message: CONFLICTS[begun.error] } as const);
    const { journal, retry } = begun;

    // The status was read after the claim began: when it shows the reset spent, resending is not needed.
    const landed =
      retry && grants !== undefined && claimLanded(journal, grants)
        ? landedAnswer(journal, grants)
        : undefined;

    let answer: ClaimAnswer = landed ?? "unknown";

    if (landed === undefined) {
      const body = claimBody(journal.grant_id, journal.request_id);

      // Both ids were checked when the claim began (grant ids by the status schema, request ids are UUIDs).
      if (body === undefined) return yield* Effect.die(new Error("invalid reset claim request"));

      const answered = yield* send(
        HttpClientRequest.post(resetGrantClaimUrl(organization)).pipe(
          HttpClientRequest.setHeaders(headers(token)),
          HttpClientRequest.bodyText(body, "application/json"),
        ),
        CLAIM_TIMEOUT,
      );

      answer = answered === undefined ? "unknown" : claimAnswer(answered.status, answered.body);
    }

    const settled = yield* Effect.result(
      call("settleResetGrantClaim", (stub) =>
        stub.models().settleResetGrantClaim(id, journal.request_id, answer),
      ),
    );

    const recorded = Result.isSuccess(settled) ? settled.success : undefined;

    yield* Effect.logInfo(
      `reset grant claim for ${id}: ${answer}${retry ? " (resent)" : ""}${landed === undefined ? "" : " (seen in the status, not sent)"}${recorded?.cooldownCleared === true ? ", cooldowns cleared" : ""}${recorded === undefined ? ", not recorded" : ""}`,
    );
    const spent = answer === "reset" || (retry && answer === "already_used");

    // The quota check also re-reads the grants; a failing check must not hide the claim's outcome.
    const checked = spent
      ? yield* checkCredentialQuota({ name: id }, { viewer }).pipe(
          Effect.orElseSucceed(() => undefined),
        )
      : undefined;

    return {
      kind: "claimed",
      outcome: answer,
      retried: retry,
      cooldownCleared: recorded?.cooldownCleared ?? false,
      ...(grants === undefined || spent ? {} : { grants }),
      ...(checked?.kind === "checked" ? { report: checked.report } : {}),
      ...(recorded?.pending === undefined ? {} : { pending: recorded.pending }),
      ...(recorded === undefined ? { warning: SETTLE_FAILED } : {}),
    } as const;
  });
