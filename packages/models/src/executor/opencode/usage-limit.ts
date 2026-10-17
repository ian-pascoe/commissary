/**
 * OpenCode Go subscription usage limits reached (5-hour rolling, weekly, monthly windows).
 *
 * No Go counterpart (no OpenCode provider in Go; see docs/ARCHITECTURE.md "OpenCode Zen and OpenCode Go"). The gateway
 * answers a request over one of the Go windows with (opencode `packages/console/app/src/routes/zen/util/handler.ts`,
 * last public at 5caf1f9):
 *
 *     429  retry-after: <seconds until the window resets>
 *     {"type":"error","error":{"type":"GoUsageLimitError","message":"5-hour usage limit reached. Resets in 2hr 13min.
 *      To continue using this model now, enable usage from your available balance: …"},
 *      "metadata":{"workspace":"…","limitName":"5 hour"}}
 *
 * The inference gateway is closed source since, so the answer is recognised narrowly: by its error type
 * (`GoUsageLimitError`, any status), or by a message that starts with the console text ("5-hour" / "Weekly" / "Monthly
 * usage limit reached") on a 402, 403 or 429 answer. A message that merely contains the phrase (a 400 echoing the
 * prompt, say) is not a limit. Callers apply it to OpenCode Go only. The cooldown is the longer of the `Retry-After`
 * header and the "Resets in …" duration of the message ("2hr 13min", "45min", "3 days", "2h 13m", …), else
 * {@link OPENCODE_LIMIT_DEFAULT_COOLDOWN_MS}, and never more than {@link OPENCODE_LIMIT_MAX_COOLDOWN_MS}. Pure functions
 * over the answer; no usage fetch on the hot path (the quota check refreshes the windows).
 */
import { asString, get, type Json, tryParseJson } from "@commissary/json";
import { parseRetryAfterMs } from "../helps/retry-after.ts";

/** Cooldown when neither `Retry-After` nor the message says when the window resets: half an hour, then a retry. */
export const OPENCODE_LIMIT_DEFAULT_COOLDOWN_MS = 30 * 60_000;

/** The longest cooldown a limit answer can set: a monthly window plus slack (a bogus header cannot park a key). */
export const OPENCODE_LIMIT_MAX_COOLDOWN_MS = 32 * 86_400_000;

/** Which subscription window was exhausted, with the ids the quota report uses (`src/quota/opencode-go.ts`). */
export type OpenCodeLimitWindow = "five_hour" | "weekly" | "monthly";

export interface OpenCodeUsageLimit {
  readonly window: OpenCodeLimitWindow | undefined;
  /** How long the key stays unusable; always set (header, message, or the default), at most the maximum. */
  readonly retryAfterMs: number;
}

/** The console message, at the start of the error message. */
const LIMIT_MESSAGE = /^\s*(5-hour|weekly|monthly) usage limit reached\b/i;

/** Statuses a limit message (without the error type) is believed on. */
const LIMIT_STATUSES: ReadonlySet<number> = new Set([402, 403, 429]);

const windowOf = (name: string): OpenCodeLimitWindow | undefined => {
  const lower = name.trim().toLowerCase();

  if (lower.startsWith("week")) return "weekly";

  if (lower.startsWith("month")) return "monthly";

  if (/^(5|five)[- ]?hour|^rolling/.test(lower)) return "five_hour";

  return undefined;
};

const UNIT_MS: ReadonlyArray<readonly [RegExp, number]> = [
  [/^(d|days?)$/, 86_400_000],
  [/^(h|hrs?|hours?)$/, 3_600_000],
  [/^(m|mins?|minutes?)$/, 60_000],
  [/^(s|secs?|seconds?)$/, 1000],
];

/**
 * The duration of the "Resets in …" phrase of a limit message in ms ("2hr 13min", "3 days", "45min", "2h 13m",
 * "1 day, 4 hours", …), read up to the sentence's end or "To continue"; `undefined` when the message has none or no
 * part of it is a known unit.
 */
export const parseResetsInMs = (message: string): number | undefined => {
  const phrase = /\bresets in\s+(.*?)(?=\.(?!\d)|\bto continue\b|$)/i.exec(message)?.[1];

  if (phrase === undefined) return undefined;
  let total = 0;
  let matched = false;

  for (const [, amount, unit] of phrase.matchAll(/\b(\d+(?:\.\d+)?)\s*([a-z]+)/gi)) {
    const ms = UNIT_MS.find(([pattern]) => pattern.test((unit ?? "").toLowerCase()))?.[1];

    if (ms === undefined) continue;
    total += Number(amount) * ms;
    matched = true;
  }

  return matched ? Math.round(total) : undefined;
};

const text = (value: Json | undefined): string => asString(value).trim();

/**
 * The usage limit an OpenCode Go error answer reports, if it is one. `body` is the answer verbatim (JSON or text, a
 * stream error event's payload included), `headers` its headers.
 */
export const openCodeUsageLimit = (
  status: number,
  body: string,
  headers: Headers,
  nowMs: number,
): OpenCodeUsageLimit | undefined => {
  const parsed = tryParseJson(body.trim());
  const typed = text(get(parsed, "error.type")).toLowerCase() === "gousagelimiterror";
  const message = parsed === undefined ? body : text(get(parsed, "error.message"));
  const matched = LIMIT_MESSAGE.exec(message);

  if (!typed && (matched === null || !LIMIT_STATUSES.has(status))) return undefined;

  const window =
    windowOf(text(get(parsed, "metadata.limitName"))) ??
    (matched === null ? undefined : windowOf(matched[1] ?? ""));

  const header = parseRetryAfterMs(headers.get("retry-after"), nowMs) ?? 0;
  const stated = Math.max(header, parseResetsInMs(message) ?? 0);
  const retryAfterMs = stated > 0 ? stated : OPENCODE_LIMIT_DEFAULT_COOLDOWN_MS;

  return { window, retryAfterMs: Math.min(retryAfterMs, OPENCODE_LIMIT_MAX_COOLDOWN_MS) };
};
