/**
 * Claude reset grants (Anthropic's `cedar_ember` program): the fixed upstream requests, the parsing of their answers
 * into the contract's `ResetGrantStatus`, which grant a claim spends, and the claim journal that keeps a double click,
 * a second tab or an unanswered claim from spending twice. Pure; the requests are made by `reset-grant-flow.ts`.
 *
 * Upstream panel source: .repos/Cli-Proxy-API-Management-Center/src/services/api/claudeResetGrants.ts (status path,
 * profile, claim request and answers, fail-closed block parsing), src/features/quota/providers/claude/
 * selectResetGrant.ts (which grant), resetGrantOperations.ts (request id reused for 10 minutes after an unknown
 * outcome, a retry bound to the first organization, a refusal on a retry keeps the claim open). Go has no counterpart:
 * the panel made these calls through `POST /requests/api-call` (not ported). Research notes and citations:
 * docs/ARCHITECTURE.md "Claude reset grants".
 *
 * Differences from the panel: the journal lives in the ControlPlane (one per account, shared by every tab and admin)
 * instead of tab memory, and a claim in flight blocks a second one for `CLAIM_LEASE_MS`; an unanswered claim older
 * than the retry window is dropped and the next claim starts from a fresh status read (the panel blocks the tab until
 * reload); `percent_used` is not kept; window ids in `clears` other than the panel's three are kept when they look
 * like ids (the panel drops them); a resend first re-reads the status and, when the grant's `resets_left` dropped or a
 * cooldown started after the claim (`claimLanded`), answers without sending: as spent when that read also shows the
 * account no longer at a limit, else as `not_confirmed` (the claim stays open; the next resend sends). One claim per organization runs or stays open at a
 * time, across every auth file of it (`busy`), and a resend names the request it means to resend (`settled` when
 * another claim replaced it).
 *
 * Assumptions (from the panel and observed traffic, not from Anthropic documentation, which does not exist for these
 * endpoints): the `request_id` is an idempotency key (a resend with it does not spend a second reset); `already_used`
 * answering a resend means the first request spent the reset; `skip_spend=1` makes the status read free of side effects;
 * the Claude Code headers (`CLAUDE_HEADERS`) are required. Clearing the proxy's cooldowns after a reset follows the Go
 * maintainers' advice, not upstream code.
 */
import { Option, Schema } from "effect";
import type { Json, JsonObject } from "../json/index.ts";
import type {
  PendingResetClaim,
  ResetGrant,
  ResetGrantBlocker,
  ResetGrantOutcome,
  ResetGrantStatus,
} from "../management/contract/credentials.ts";

const ANTHROPIC_ORIGIN = "https://api.anthropic.com";

/** The usage endpoint with the grant block evaluated (without `cedar_ember=1` Anthropic answers `cedar_ember: null`). */
export const RESET_GRANT_STATUS_URL = `${ANTHROPIC_ORIGIN}/api/oauth/usage?cedar_ember=1&skip_spend=1`;

export const RESET_GRANT_PROGRAM = "cedar_ember";

/** The panel's bound for the claim, "the same bound the Claude Code client uses". */
export const CLAIM_TIMEOUT = "25 seconds";

/** How long an unanswered claim can be resent with its request id (the panel's `RETRY_WINDOW_MS`). */
export const RETRY_WINDOW_MS = 10 * 60_000;

/** How long a started claim blocks another one: the 25 s claim plus the status and profile reads. */
export const CLAIM_LEASE_MS = 60_000;

const GRANT_ID = /^[a-z0-9_-]{1,40}$/;

const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

const ORGANIZATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const WINDOW_ID = /^[a-z0-9_]{1,80}$/;

/** The claim endpoint of an organization (only ever a UUID, checked by `parseOrganization`). */
export const resetGrantClaimUrl = (organization: string): string =>
  `${ANTHROPIC_ORIGIN}/api/organizations/${organization}/reset_rate_limits`;

/** The claim body; `undefined` when the grant or request id is not of the expected shape. */
export const claimBody = (grantId: string, requestId: string): string | undefined =>
  GRANT_ID.test(grantId) && REQUEST_ID.test(requestId)
    ? JSON.stringify({ program: RESET_GRANT_PROGRAM, grant_id: grantId, request_id: requestId })
    : undefined;

// --- status ---------------------------------------------------------------------------------------------------------

const KNOWN_INELIGIBLE_REASONS: ReadonlySet<string> = new Set([
  "config_off",
  "tier",
  "seat",
  "mobile",
  "surface",
  "cli_version",
  "no_grant",
  "tenure",
  "other_experiment",
  "unavailable",
  "unknown",
]);

const Timestamp = Schema.String.check(
  Schema.makeFilter((value: string) => !Number.isNaN(Date.parse(value)) || "invalid timestamp"),
);

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Absent or `null` is "not given"; any other value must match. */
const maybe = <S extends Schema.Top>(schema: S) => Schema.optionalKey(Schema.NullOr(schema));

const UpstreamGrant = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(GRANT_ID)),
  label: maybe(Schema.String),
  resets_total: Count,
  resets_left: Count,
  starts_at: maybe(Timestamp),
  ends_at: maybe(Timestamp),
  clears: maybe(Schema.Array(Schema.String)),
  paused: maybe(Schema.Boolean),
  usable_now: maybe(Schema.Boolean),
  use_requires_limit: maybe(Schema.Boolean),
}).check(
  Schema.makeFilter(
    (grant) => grant.resets_left <= grant.resets_total || "more resets left than granted",
  ),
);

const UpstreamBlock = Schema.Struct({
  eligible: Schema.Boolean,
  ineligible_reason: maybe(Schema.String),
  at_limit: maybe(Schema.Boolean),
  weekly_resets_at: maybe(Timestamp),
  cooldown_until: maybe(Timestamp),
  next_grant_id: maybe(Schema.String),
  grants: maybe(Schema.Array(UpstreamGrant)),
});

const decodeUsage = Schema.decodeUnknownOption(Schema.Struct({ cedar_ember: UpstreamBlock }));

const decodeProfile = Schema.decodeUnknownOption(
  Schema.Struct({
    organization: Schema.Struct({ uuid: Schema.String.check(Schema.isPattern(ORGANIZATION_ID)) }),
  }),
);

const iso = (raw: string | null | undefined): string | undefined =>
  raw === null || raw === undefined ? undefined : new Date(Date.parse(raw)).toISOString();

/** Upstream display text without control characters, collapsed and bounded (the panel's `safeLabel`). */
const safeLabel = (raw: string | null | undefined): string =>
  (raw ?? "")
    // Strip untrusted display control characters.
    // oxlint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);

const at = (raw: string | undefined): number | undefined =>
  raw === undefined ? undefined : Date.parse(raw);

/** Has resets left and is inside its dates at `now`. */
const live = (grant: ResetGrant, now: number): boolean =>
  grant.resets_left > 0 &&
  (at(grant.starts_at) ?? -Infinity) <= now &&
  (at(grant.ends_at) ?? Infinity) > now;

type Unselected = Omit<ResetGrantStatus, "claimable" | "blocked_by">;

/**
 * The grant a claim spends at `now` (the panel's `selectResetGrant` and `anthropicResetGrantBlocker`): Anthropic's
 * `next_grant_id` when usable, else the lowest usable id; otherwise why none is.
 */
export const selectResetGrant = (
  status: Unselected,
  now: number,
): { readonly claimable: string } | { readonly blocked_by: ResetGrantBlocker } => {
  if (!status.eligible) return { blocked_by: "ineligible" };

  if ((at(status.cooldown_until) ?? -Infinity) > now) return { blocked_by: "cooldown" };
  const left = status.grants.filter((grant) => live(grant, now));

  if (left.length === 0) return { blocked_by: "none_left" };
  const usable = left.filter((grant) => !grant.paused && grant.usable_now);

  if (usable.length === 0) return { blocked_by: "unusable" };
  const ready = usable.filter((grant) => !grant.use_requires_limit || status.at_limit);

  if (ready.length === 0) return { blocked_by: "not_limited" };
  const [lowest] = ready.map((grant) => grant.id).toSorted((a, b) => (a < b ? -1 : 1));
  const next = ready.find((grant) => grant.id === status.next_grant_id)?.id ?? lowest;

  return next === undefined ? { blocked_by: "none_left" } : { claimable: next };
};

/**
 * The `cedar_ember` block of a status answer, read at `checkedAt`; `undefined` when it is missing or malformed (one
 * bad grant, a duplicate id or a bad timestamp rejects the whole block, as in the panel). Missing usability flags take
 * the refusing side: not usable now, needs a limit.
 */
export const parseResetGrantStatus = (
  payload: Json | undefined,
  checkedAt: number,
): ResetGrantStatus | undefined => {
  const decoded = Option.getOrUndefined(decodeUsage(payload));

  if (decoded === undefined) return undefined;
  const block = decoded.cedar_ember;
  const raw = block.grants ?? [];
  const ids = new Set(raw.map((grant) => grant.id));

  if (ids.size !== raw.length) return undefined;

  const grants = raw.map((grant): ResetGrant => {
    const startsAt = iso(grant.starts_at);
    const endsAt = iso(grant.ends_at);

    return {
      id: grant.id,
      label: safeLabel(grant.label),
      resets_total: grant.resets_total,
      resets_left: grant.resets_left,
      ...(startsAt === undefined ? {} : { starts_at: startsAt }),
      ...(endsAt === undefined ? {} : { ends_at: endsAt }),
      clears: [...new Set((grant.clears ?? []).filter((window) => WINDOW_ID.test(window)))],
      paused: grant.paused ?? false,
      usable_now: grant.usable_now ?? false,
      use_requires_limit: grant.use_requires_limit ?? true,
    };
  });

  const reason = block.ineligible_reason;
  const next = block.next_grant_id;
  const cooldown = iso(block.cooldown_until);
  const weekly = iso(block.weekly_resets_at);

  const status: Unselected = {
    checked_at: new Date(checkedAt).toISOString(),
    eligible: block.eligible,
    ...(reason === null || reason === undefined
      ? {}
      : { ineligible_reason: KNOWN_INELIGIBLE_REASONS.has(reason) ? reason : "unknown" }),
    at_limit: block.at_limit ?? false,
    ...(cooldown === undefined ? {} : { cooldown_until: cooldown }),
    ...(weekly === undefined ? {} : { weekly_resets_at: weekly }),
    ...(typeof next === "string" && ids.has(next) ? { next_grant_id: next } : {}),
    grants,
  };

  return { ...status, ...selectResetGrant(status, checkedAt) };
};

/** The status as a plain JSON object (credential list entries are `JsonObject`s). */
export const resetGrantStatusJson = (status: ResetGrantStatus): JsonObject => ({
  ...status,
  grants: status.grants.map((grant) => ({ ...grant, clears: [...grant.clears] })),
});

/** `organization.uuid` of an `/api/oauth/profile` answer, lower-cased. */
export const parseOrganization = (payload: Json | undefined): string | undefined =>
  Option.getOrUndefined(decodeProfile(payload))?.organization.uuid.toLowerCase();

// --- claim answer ---------------------------------------------------------------------------------------------------

/** What Anthropic answered a claim with; everything else is `unknown` (a reset may have been spent). */
export type ClaimAnswer = Exclude<ResetGrantOutcome, "none_available">;

const RESULTS: ReadonlySet<string> = new Set([
  "reset",
  "already_used",
  "not_limited",
  "cooldown",
  "ineligible",
  "unavailable",
]);

const decodeResult = Schema.decodeUnknownOption(Schema.Struct({ result: Schema.String }));

/**
 * The panel's `claimClaudeResetGrant` mapping: 429 and 401/403 prove nothing was spent; a 2xx needs a known `result`
 * ("HTTP 200 alone is not a reset"); any other status or body is an unknown outcome.
 */
export const claimAnswer = (status: number, payload: Json | undefined): ClaimAnswer => {
  if (status === 429) return "rate_limited";

  if (status === 401 || status === 403) return "auth_error";

  if (status < 200 || status >= 300) return "unknown";
  const result = Option.getOrUndefined(decodeResult(payload))?.result;

  // SAFETY: `RESULTS` holds exactly the `ClaimAnswer` results Anthropic sends.
  return result !== undefined && RESULTS.has(result) ? (result as ClaimAnswer) : "unknown";
};

// --- claim journal --------------------------------------------------------------------------------------------------

/** One account's open claim (stored by `reset-grant-store.ts`; carries no secret, the request id is a nonce). */
export const ClaimJournal = Schema.Struct({
  grant_id: Schema.String,
  organization: Schema.String,
  request_id: Schema.String,
  started_at: Schema.Number,
  /** The grant's `resets_left` in the status the claim was decided on (absent on a resend of an older journal). */
  resets_left: Schema.optionalKey(Schema.Int),
  /** Until when the claim counts as in flight (0 once it has an answer or none is coming). */
  in_flight_until: Schema.Number,
  attempts: Schema.Int,
  /** A status hinted the claim landed while the account stayed at a limit (`not_confirmed`): the next resend sends. */
  unconfirmed: Schema.optionalKey(Schema.Boolean),
});

export type ClaimJournal = typeof ClaimJournal.Type;

/** The open claim that can still be resent at `now`. */
export const openClaim = (
  journal: ClaimJournal | undefined,
  now: number,
): ClaimJournal | undefined =>
  journal !== undefined && now - journal.started_at < RETRY_WINDOW_MS ? journal : undefined;

export const pendingClaimJson = (journal: ClaimJournal, now: number): PendingResetClaim => ({
  grant_id: journal.grant_id,
  started_at: new Date(journal.started_at).toISOString(),
  retry_until: new Date(journal.started_at + RETRY_WINDOW_MS).toISOString(),
  in_flight: journal.in_flight_until > now,
});

/** A claim to start: the grant, a new request id and the grant's `resets_left` it was decided on. */
export interface FreshClaim {
  readonly grantId: string;
  readonly requestId: string;
  readonly resetsLeft?: number;
}

export type BeginClaimError = "busy" | "identity" | "expired" | "settled" | "stale";

/** Whether `journal` (another auth file's) blocks a claim for `organization`: it is in flight or can still be resent. */
export const holdsOrganization = (
  journal: ClaimJournal,
  organization: string,
  now: number,
): boolean =>
  journal.organization === organization &&
  (journal.in_flight_until > now || openClaim(journal, now) !== undefined);

export type BeginClaim =
  | { readonly ok: true; readonly journal: ClaimJournal; readonly retry: boolean }
  | { readonly ok: false; readonly error: BeginClaimError };

/**
 * Starts a claim at `now`. Another claim in flight answers `busy`, and so does a claim in flight or open in another
 * auth file of the same organization (`others`: two files, or a file re-logged into the organization, would otherwise
 * spend two resets of one account). An open claim is resent (same grant and request id) when it belongs to the same
 * organization (`identity` otherwise: the account was replaced) and is the one the caller saw (`resend`, its request
 * id; `settled` otherwise: another claim replaced it). With no open claim,
 * `fresh` starts one, but only when the status it was decided on was read after the account's last claim activity
 * (`current`; `stale` otherwise: that status may predate a reset another claim spent). Without `fresh` (the caller
 * meant to resend a claim) the answer is `settled` when the claim was closed meanwhile, `expired` when it outlived its
 * retry window.
 */
export const beginClaim = (
  journal: ClaimJournal | undefined,
  input: {
    readonly organization: string;
    readonly fresh: FreshClaim | undefined;
    readonly resend?: string | undefined;
    readonly current: boolean;
    readonly others?: readonly ClaimJournal[];
  },
  now: number,
): BeginClaim => {
  if (journal !== undefined && journal.in_flight_until > now) return { ok: false, error: "busy" };

  if ((input.others ?? []).some((other) => holdsOrganization(other, input.organization, now)))
    return { ok: false, error: "busy" };
  const open = openClaim(journal, now);

  if (open !== undefined) {
    if (open.organization !== input.organization) return { ok: false, error: "identity" };

    if (input.resend !== undefined && open.request_id !== input.resend)
      return { ok: false, error: "settled" };

    return {
      ok: true,
      retry: true,
      journal: { ...open, in_flight_until: now + CLAIM_LEASE_MS, attempts: open.attempts + 1 },
    };
  }

  if (input.fresh === undefined)
    return { ok: false, error: journal === undefined ? "settled" : "expired" };

  if (!input.current) return { ok: false, error: "stale" };

  return {
    ok: true,
    retry: false,
    journal: {
      grant_id: input.fresh.grantId,
      organization: input.organization,
      request_id: input.fresh.requestId,
      ...(input.fresh.resetsLeft === undefined ? {} : { resets_left: input.fresh.resetsLeft }),
      started_at: now,
      in_flight_until: now + CLAIM_LEASE_MS,
      attempts: 1,
    },
  };
};

/**
 * Records the answer to the claim `requestId`. A definite answer closes the claim, except a refusal of a resend, which
 * cannot prove the first, unanswered request did not spend (the panel's rule); `unknown` keeps it open, and so does
 * `not_confirmed` (no request sent, see `landedAnswer`), marked `unconfirmed` so the next resend sends the same
 * request instead of answering from the status again. `spent`: the account's limits were reset (`reset`,
 * or `already_used` on a resend: the first request spent it).
 */
export interface SettledClaim {
  readonly journal: ClaimJournal | undefined;
  readonly spent: boolean;
}

export const settleClaim = (
  journal: ClaimJournal | undefined,
  requestId: string,
  answer: ClaimAnswer,
): SettledClaim => {
  if (journal === undefined || journal.request_id !== requestId)
    return { journal, spent: answer === "reset" };
  const retry = journal.attempts > 1;
  const spent = answer === "reset" || (retry && answer === "already_used");
  const keepOpen = answer === "unknown" || (retry && !spent);

  if (!keepOpen) return { journal: undefined, spent };

  return {
    journal: {
      ...journal,
      in_flight_until: 0,
      ...(answer === "not_confirmed" ? { unconfirmed: true } : {}),
    },
    spent,
  };
};

/**
 * Whether a status read after the claim `journal` began shows that it spent its reset: the grant has fewer resets left
 * than when the claim was decided, or a reset cooldown runs from after the claim started (assumption: only a spent
 * reset lowers `resets_left` or starts `cooldown_until`). A resend then sends nothing; `landedAnswer` says how the
 * claim is closed.
 */
export const claimLanded = (journal: ClaimJournal, status: ResetGrantStatus): boolean => {
  const grant = status.grants.find((candidate) => candidate.id === journal.grant_id);

  const dropped =
    grant !== undefined &&
    journal.resets_left !== undefined &&
    grant.resets_left < journal.resets_left;

  return dropped || (at(status.cooldown_until) ?? -Infinity) > journal.started_at;
};

/**
 * How a resend whose claim landed (`claimLanded`) is answered without sending: as spent (`already_used` on a resend)
 * only when the same read shows the account no longer at a limit, else `not_confirmed` (the hint alone does not prove
 * a reset, and clearing the proxy's cooldowns on it could send traffic to a still limited account). `undefined`: send
 * the resend after all, since an earlier resend already answered `not_confirmed` (`unconfirmed`) and the operator
 * tries again; the same `request_id` cannot spend a second reset.
 */
export const landedAnswer = (
  journal: ClaimJournal,
  status: ResetGrantStatus,
): "already_used" | "not_confirmed" | undefined =>
  !status.at_limit ? "already_used" : journal.unconfirmed === true ? undefined : "not_confirmed";
