// Claude reset grants as the Account page shows them: how many resets are left, each grant's line, whether a reset can
// be used now (and why not), and what an attempt's outcome means. Operator-facing copy says "reset" and "attempt",
// never "claim". The server decides and re-checks before every attempt
// (packages/models/src/quota/reset-grant-flow.ts); this only words its answers. Pure: tested in test/reset-grants.test.ts.
import type {
  ResetGrant,
  ResetGrantOutcome,
  ResetGrantStatus,
} from "@commissary/contract/credentials";
import { formatClock, formatDate, formatDuration, formatMoment } from "./format.ts";

const WINDOW_NAMES: ReadonlyMap<string, string> = new Map([
  ["five_hour", "5-hour"],
  ["seven_day", "weekly"],
  ["seven_day_overage_included", "weekly with overage"],
  ["seven_day_opus", "weekly Opus"],
  ["seven_day_sonnet", "weekly Sonnet"],
]);

const DAY = 86_400_000;

const at = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined;
  const parsed = Date.parse(raw);

  return Number.isNaN(parsed) ? undefined : parsed;
};

const named = (names: ReadonlyArray<string>): string =>
  names.length === 1
    ? `the ${names[0]} window`
    : `the ${names.slice(0, -1).join(", ")} and ${names.at(-1)} windows`;

/**
 * The windows a reset empties, in a sentence: "the 5-hour and weekly windows". Ids without a name are never shown raw:
 * "the 5-hour window and another window", "2 usage windows".
 */
export const windowList = (clears: ReadonlyArray<string>): string => {
  const names = clears.flatMap((id) => {
    const name = WINDOW_NAMES.get(id);

    return name === undefined ? [] : [name];
  });

  const unnamed = clears.length - names.length;

  if (unnamed === 0) return names.length === 0 ? "the usage windows" : named(names);

  if (names.length === 0) return unnamed === 1 ? "a usage window" : `${unnamed} usage windows`;

  return `${named(names)} and ${unnamed === 1 ? "another window" : `${unnamed} other windows`}`;
};

const resets = (count: number): string => (count === 1 ? "1 reset" : `${count} resets`);

/** A grant can be spent at `now`: resets left, inside its dates. */
const live = (grant: ResetGrant, now: number): boolean =>
  grant.resets_left > 0 &&
  (at(grant.starts_at) ?? -Infinity) <= now &&
  (at(grant.ends_at) ?? Infinity) > now;

export interface GrantLine {
  readonly id: string;
  /** Anthropic's label, or "Grant n". */
  readonly name: string;
  /** "2 of 3 left". */
  readonly left: string;
  /** "Expires Oct 30, 2026, in 19 d", "Starts Oct 12, 2026", "Expired Oct 1, 2026", "No end date given". */
  readonly when: string;
  /** Why this grant cannot be spent now, when it cannot. */
  readonly holdup: string | undefined;
  /** Usable now (counts toward the resets left). */
  readonly live: boolean;
  /** The grant the next reset would spend, as of the last read ("Next to use"). */
  readonly next: boolean;
}

const when = (grant: ResetGrant, now: number): string => {
  const starts = at(grant.starts_at);
  const ends = at(grant.ends_at);

  if (starts !== undefined && starts > now) return `Starts ${formatDate(starts)}`;

  if (ends === undefined) return "No end date given";

  if (ends <= now) return `Expired ${formatDate(ends)}`;

  const days = Math.floor((ends - now) / DAY);

  return `Expires ${formatDate(ends)}, in ${days >= 2 ? `${days} d` : formatDuration(ends - now)}`;
};

const holdup = (grant: ResetGrant, atLimit: boolean, now: number): string | undefined => {
  if (grant.resets_left === 0) return "Used up";

  if (!live(grant, now))
    return (at(grant.starts_at) ?? -Infinity) > now ? "Not started" : "Expired";

  if (grant.paused) return "Paused by Anthropic";

  if (!grant.usable_now) return "Not usable yet";

  if (grant.use_requires_limit && !atLimit) return "Only at a limit";

  return undefined;
};

/** Resets left over the grants inside their dates at `now`. */
const resetsLeft = (status: ResetGrantStatus, now: number): number =>
  status.grants
    .filter((grant) => live(grant, now))
    .reduce((sum, grant) => sum + grant.resets_left, 0);

/** Grants usable now first, each group by end date; Anthropic's order names unlabelled ones ("Grant 2"). */
export const grantLines = (status: ResetGrantStatus, now: number): ReadonlyArray<GrantLine> =>
  status.grants
    .map((grant, index) => ({
      grant,
      name: grant.label === "" ? `Grant ${index + 1}` : grant.label,
    }))
    .toSorted(
      (a, b) =>
        Number(live(b.grant, now)) - Number(live(a.grant, now)) ||
        (at(a.grant.ends_at) ?? Infinity) - (at(b.grant.ends_at) ?? Infinity),
    )
    .map(({ grant, name }): GrantLine => ({
      id: grant.id,
      name,
      left: `${grant.resets_left} of ${grant.resets_total} left`,
      when: when(grant, now),
      holdup: holdup(grant, status.at_limit, now),
      live: live(grant, now),
      next: grant.id === status.claimable,
    }));

const INELIGIBLE: ReadonlyMap<string, string> = new Map([
  ["config_off", "the programme is switched off"],
  ["tier", "the plan does not include them"],
  ["seat", "the seat type does not include them"],
  ["no_grant", "no grant was given"],
  ["tenure", "the account is too new"],
  ["unavailable", "they are unavailable right now"],
]);

/** Can the operator ask for a reset: `ready` (one is claimable), `maybe` (the last read said no, but that can change by the time the server re-checks), `blocked`. */
export type Readiness = "ready" | "maybe" | "blocked";

export interface ResetsView {
  /** Resets left over the grants usable now. */
  readonly left: number;
  /** "2 resets left", "No resets left", "Not offered". */
  readonly headline: string;
  /** What using one does, or why none can be used. */
  readonly detail: string;
  readonly readiness: Readiness;
  readonly lines: ReadonlyArray<GrantLine>;
}

/** What the page knows beside the status. */
export interface ResetsContext {
  /** An attempt got no answer and can be tried again: it may have spent one of the resets counted. */
  readonly unanswered?: boolean;
  /** Another tab is using a reset of the account right now. */
  readonly inFlight?: boolean;
  /** When this page last saw a reset empty the limits. */
  readonly emptiedAt?: number | undefined;
}

const withContext = (view: ResetsView, context: ResetsContext, now: number): ResetsView => {
  const { left } = view;

  if (context.inFlight === true)
    return {
      ...view,
      detail: "A reset is being used from another tab right now. Check resets in a minute.",
      readiness: "blocked",
    };

  if (context.unanswered === true && left > 0)
    return {
      ...view,
      headline: `${resets(left)} left, or ${left === 1 ? "none" : left - 1} if the last attempt went through`,
      lines: view.lines.map((line) => ({ ...line, next: false })),
    };

  if (context.emptiedAt !== undefined)
    return { ...view, detail: `Limits emptied at ${formatMoment(context.emptiedAt, now)}.` };

  return view;
};

/** The status read at `checked_at`, seen at `now`, with what the page knows beside it. */
export const resetsView = (
  status: ResetGrantStatus,
  now: number,
  context: ResetsContext = {},
): ResetsView => withContext(baseView(status, now), context, now);

const baseView = (status: ResetGrantStatus, now: number): ResetsView => {
  const lines = grantLines(status, now);
  const left = resetsLeft(status, now);
  const next = status.grants.find((grant) => grant.id === status.claimable);
  const cooldownUntil = at(status.cooldown_until);

  if (!status.eligible) {
    const reason = INELIGIBLE.get(status.ineligible_reason ?? "");

    return {
      left,
      headline: "Not offered",
      detail: `Anthropic does not offer resets to this account${reason === undefined ? "" : `: ${reason}`}.`,
      readiness: "blocked",
      lines,
    };
  }

  const headline = left === 0 ? "No resets left" : `${resets(left)} left`;

  if (left === 0) {
    const upcoming = status.grants
      .map((grant) => at(grant.starts_at))
      .filter((start): start is number => start !== undefined && start > now)
      .toSorted((a, b) => a - b)[0];

    return {
      left,
      headline,
      detail:
        upcoming === undefined
          ? "Every grant is used up or expired."
          : `Every grant is used up or expired. The next one starts ${formatDate(upcoming)}.`,
      readiness: "blocked",
      lines,
    };
  }

  if (cooldownUntil !== undefined && cooldownUntil > now) {
    return {
      left,
      headline,
      detail: `Anthropic allows the next reset in ${formatDuration(cooldownUntil - now)}, ${formatClock(cooldownUntil)}.`,
      readiness: "blocked",
      lines,
    };
  }

  if (next !== undefined && live(next, now)) {
    return {
      left,
      headline,
      detail: `Using one empties ${windowList(next.clears)} at Anthropic. It cannot be undone.`,
      readiness: "ready",
      lines,
    };
  }

  return {
    left,
    headline,
    detail:
      status.blocked_by === "not_limited" || (status.blocked_by === undefined && !status.at_limit)
        ? "These resets work only once the account reaches a limit, and it had not when last read."
        : "The grants with resets left were paused or not usable yet when last read.",
    readiness: "maybe",
    lines,
  };
};

export interface AttemptNotice {
  /** `done`: limits were reset; `held`: nothing was spent; `problem`: a reset may have been spent unseen. */
  readonly tone: "done" | "held" | "problem";
  readonly text: string;
}

/** What one attempt's answer means for the operator. `retryUntil`: until when it can be tried again, when it can. */
export const attemptNotice = (attempt: {
  readonly outcome: ResetGrantOutcome;
  readonly retried: boolean;
  readonly cooldownCleared: boolean;
  readonly retryUntil?: number | undefined;
  readonly blocked?: string | undefined;
}): AttemptNotice => {
  const cleared = attempt.cooldownCleared ? " Commissary cleared its cooldowns too." : "";

  switch (attempt.outcome) {
    case "reset":
      return { tone: "done", text: `Reset used. Anthropic emptied the limits.${cleared}` };
    case "already_used":
      return attempt.retried
        ? {
            tone: "done",
            text: `The earlier attempt had already used the reset, so nothing more was spent.${cleared}`,
          }
        : { tone: "held", text: "Anthropic says this reset was already used. Nothing was spent." };
    case "not_limited":
      return {
        tone: "held",
        text: "Nothing was spent: Anthropic says the account is not at a limit.",
      };
    case "cooldown":
      return {
        tone: "held",
        text: "Nothing was spent: Anthropic's pause between resets is still running.",
      };
    case "ineligible":
      return {
        tone: "held",
        text: "Nothing was spent: Anthropic says this account cannot use resets.",
      };
    case "unavailable":
      return {
        tone: "held",
        text: "Nothing was spent: Anthropic has no reset available right now.",
      };
    case "rate_limited":
      return {
        tone: "held",
        text: "Nothing was spent: Anthropic is turning requests away. Try again in a few minutes.",
      };
    case "auth_error":
      return {
        tone: "problem",
        text: "Nothing was spent: Anthropic refused the account's token. Refresh the tokens, then try again.",
      };
    case "none_available":
      return {
        tone: "held",
        text: `Nothing was spent: ${attempt.blocked ?? "no reset can be used now."}`,
      };
    case "not_confirmed":
      return {
        tone: "problem",
        text: "The last attempt is unconfirmed: the account is still limited. Check resets to see whether it went through.",
      };
    case "unknown":
      return {
        tone: "problem",
        text:
          attempt.retryUntil === undefined
            ? "Anthropic did not answer, so a reset may have been spent. Check quota to see whether the limits were emptied."
            : `Anthropic did not answer, so a reset may have been spent. Try again before ${formatClock(attempt.retryUntil)}: Commissary sends the same request again, which cannot spend a second reset.`,
      };
  }
};

/**
 * The warning while an unanswered attempt can be tried again (until `retryUntil`). `unconfirmed`: the last try was
 * answered `not_confirmed` (the status hinted it landed, but the account is still limited).
 */
export const unansweredWarning = (retryUntil: number, unconfirmed: boolean): string =>
  unconfirmed
    ? `The last attempt is unconfirmed: the account is still limited. Trying again before ${formatClock(retryUntil)} sends the same request, which cannot spend another reset.`
    : `Anthropic did not answer the last attempt, so a reset may have been spent. Trying again before ${formatClock(retryUntil)} sends the same request, which cannot spend another.`;

export interface ResetsBrief {
  readonly text: string;
  /** `ink` when the account is at a limit and one can be used now (worth acting on), else `quiet`. */
  readonly tone: "ink" | "quiet";
}

/** The short line under an account's meters in the list: "2 resets left", "3 resets left, one usable now", or nothing. */
export const resetsBrief = (
  status: ResetGrantStatus | undefined,
  now: number,
): ResetsBrief | undefined => {
  if (status === undefined || !status.eligible) return undefined;
  const left = resetsLeft(status, now);

  if (left === 0) return undefined;

  return status.at_limit && status.claimable !== undefined
    ? { text: `${resets(left)} left, one usable now`, tone: "ink" }
    : { text: `${resets(left)} left`, tone: "quiet" };
};
