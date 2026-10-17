/**
 * Spend limits, the shapes shared by the store, the ledger and the selection (issue #71). New in the Workers port, no Go
 * counterpart.
 *
 * A **Spend limit** caps the Cost (micro-USD) that one subject may spend in one period. The subject is a member, a team,
 * the org, a shared credential or an API key; the periods are a day, a week and a month in the org's time zone
 * (`period.ts`). Spend is counted per **scope** (a subject) and period, not per limit: an admin's and a member's limit
 * on one API key share a counter. A counter starts when the first limit of its scope and period is written, and goes
 * when the last one is deleted.
 */
import { Schema } from "effect";
import type { Period, WeekStart } from "./period.ts";

export const SUBJECT_KINDS = ["member", "team", "org", "credential", "key"] as const;

export type SubjectKind = (typeof SUBJECT_KINDS)[number];

/** The subject of the `org` kind: the org itself has no id. */
export const ORG_SUBJECT = "";

/** A subject whose Spend is counted: it crosses the Durable Object RPC boundary inside a lease. */
export const SpendScope = Schema.Struct({
  kind: Schema.Literals(SUBJECT_KINDS),
  subject: Schema.String,
});

export type SpendScope = typeof SpendScope.Type;

/** Who wrote a limit: an org admin (any subject) or a member (their own API keys only). */
export const LIMIT_SOURCES = ["admin", "member"] as const;

export type LimitSource = (typeof LIMIT_SOURCES)[number];

export interface SpendLimit {
  readonly id: string;
  readonly kind: SubjectKind;
  /** A member, team, credential or API key id; empty for the org. */
  readonly subject: string;
  readonly period: Period;
  /** Micro-USD (1 USD = 1,000,000), at least 0 (nothing may be spent). */
  readonly amountMicros: number;
  readonly source: LimitSource;
  /** Counts the edits of this entry, so an editor holding an old copy is refused (`If-Match`). */
  readonly revision: number;
  /** Epoch milliseconds. */
  readonly createdAt: number;
  readonly updatedAt: number;
  /** The principal that wrote it last. */
  readonly updatedBy: string;
}

/** The org's calendar for periods: an IANA time zone and the first day of the week. */
export interface SpendSettings {
  readonly timeZone: string;
  readonly weekStart: WeekStart;
}

/** The limit a request ran into: which subject's, in which period, and when the period ends (epoch ms). */
export interface Refusal {
  readonly kind: SubjectKind;
  readonly period: Period;
  readonly resetsAt: number;
}

/**
 * What the Spend limits say about a request before a credential is chosen:
 * - `refuse`: a limit of the request's API key has no room, so nothing may serve it;
 * - `sharedBlocked`: a member, team or org limit has no room, so only the member's private credentials may serve it;
 * - `credentials`: the shared credentials whose own limit has no room, skipped like unavailable ones.
 */
export interface SpendGate {
  readonly refuse?: Refusal;
  readonly sharedBlocked?: Refusal;
  readonly credentials: ReadonlyMap<string, Refusal>;
}

/** Who a request is for, as the limits see it. */
export interface SpendCaller {
  readonly memberId?: string | undefined;
  readonly apiKeyId?: string | undefined;
}
