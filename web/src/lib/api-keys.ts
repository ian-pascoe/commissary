// The API keys page's model: a key's status, how its columns read, the order of the list, the checks that mirror the
// server's (src/api-keys/store.ts) and what a refused write tells the caller. Pure: no DOM, tested in
// test/web-api-keys.test.ts.
import type { ApiKeyView } from "#contract/api-keys.ts";
import { asSentence } from "./failure.ts";
import { formatAgo, formatDate } from "./format.ts";

/** A key's name is 1 to 100 characters (code points, as the server counts), without control characters. */
export const KEY_NAME_MAX = 100;

/** The most keys a member holds. A revoked or expired key is deleted, so only keys that work count (ADR 0027). */
export const KEYS_PER_MEMBER = 100;

export type KeyStatus = "active" | "expired" | "revoked";

const instant = (iso: string | undefined): number | undefined => {
  if (iso === undefined) return undefined;
  const ms = Date.parse(iso);

  return Number.isNaN(ms) ? undefined : ms;
};

/**
 * The server deletes a revoked or expired key, so the list holds keys that work; a key expires at its `expires_at`
 * instant, as the server reads it, and the page may show one for the moment between that instant and the next reload.
 * Revoked wins over expired for the answer of a revocation.
 */
export const keyStatus = (key: ApiKeyView, now: number): KeyStatus => {
  if (key.revoked_at !== undefined) return "revoked";
  const expires = instant(key.expires_at);

  return expires !== undefined && now >= expires ? "expired" : "active";
};

const STATUS_LABELS: Readonly<Record<KeyStatus, string>> = {
  active: "Active",
  expired: "Expired",
  revoked: "Revoked",
};

export const statusLabel = (status: KeyStatus): string => STATUS_LABELS[status];

/** Only a key that still works needs revoking. */
export const canRevoke = (key: ApiKeyView, now: number): boolean =>
  keyStatus(key, now) !== "revoked";

const RANK: Readonly<Record<KeyStatus, number>> = { active: 0, expired: 1, revoked: 2 };

/** Keys that work first, then expired, then revoked; each group newest first. */
export const sortKeys = (keys: ReadonlyArray<ApiKeyView>, now: number): ReadonlyArray<ApiKeyView> =>
  keys.toSorted(
    (a, b) =>
      RANK[keyStatus(a, now)] - RANK[keyStatus(b, now)] ||
      (instant(b.created_at) ?? 0) - (instant(a.created_at) ?? 0) ||
      a.id.localeCompare(b.id),
  );

export type KeyFilter = "active" | "all";

export const KEY_FILTERS: ReadonlyArray<{ readonly id: KeyFilter; readonly label: string }> = [
  { id: "active", label: "Active" },
  { id: "all", label: "All" },
];

export const filterKeys = (
  keys: ReadonlyArray<ApiKeyView>,
  filter: KeyFilter,
  now: number,
): ReadonlyArray<ApiKeyView> =>
  filter === "all" ? keys : keys.filter((key) => keyStatus(key, now) === "active");

/** The member column shows for org admins (who see every key) and whenever a key is someone else's. */
export const showMemberColumn = (keys: ReadonlyArray<ApiKeyView>, admin: boolean): boolean =>
  admin || keys.some((key) => !key.mine);

/** Whose key it is: their email, their member id when the server sent no email. */
export const memberName = (key: ApiKeyView): string => key.member_email ?? key.member_id;

/** When the key last authenticated a request: "never" until its first, then how long ago. */
export const lastUsedText = (key: ApiKeyView, now: number): string => {
  const used = instant(key.last_used_at);

  return used === undefined ? "Never" : formatAgo(Math.max(0, now - used));
};

export const createdText = (key: ApiKeyView): string => {
  const created = instant(key.created_at);

  return created === undefined ? key.created_at : formatDate(created);
};

export const expiresText = (key: ApiKeyView): string => {
  if (key.expires_at === undefined) return "No expiry";
  const expires = instant(key.expires_at);

  return expires === undefined ? key.expires_at : formatDate(expires);
};

/** When a revoked key was revoked ("Oct 10, 2026"), for the caption under its status. */
export const revokedText = (key: ApiKeyView): string | undefined => {
  const revoked = instant(key.revoked_at);

  return revoked === undefined ? undefined : formatDate(revoked);
};

// ---------------------------------------------------------------------------------------------------------------
// The new-key form

const isControl = (character: string): boolean => {
  const code = character.codePointAt(0) ?? 0;

  return code < 0x20 || code === 0x7f;
};

/** What is wrong with a typed key name, or `undefined` when it will do. */
export const keyNameProblem = (text: string): string | undefined => {
  const name = text.trim();

  if (name === "") return "Name the key after where it is used, such as “laptop pi”.";

  const characters = Array.from(name);

  if (characters.length > KEY_NAME_MAX) return `A name is up to ${KEY_NAME_MAX} characters.`;

  return characters.some(isControl) ? "A name has no control characters." : undefined;
};

const DAY_INPUT = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The last instant of a calendar day (`<input type="date">`'s `YYYY-MM-DD`) in the browser's time zone. */
const endOfDay = (day: string): Date | undefined => {
  const parts = DAY_INPUT.exec(day.trim());

  if (parts === null) return undefined;
  const [year, month, date] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const end = new Date(year, month - 1, date, 23, 59, 59, 999);

  // `new Date(2026, 1, 31)` rolls over to March: refuse a day that does not exist.
  return end.getFullYear() === year && end.getMonth() === month - 1 && end.getDate() === date
    ? end
    : undefined;
};

/** What is wrong with a typed expiry day (empty means no expiry), or `undefined` when it will do. */
export const expiryProblem = (day: string, now: number): string | undefined => {
  if (day.trim() === "") return undefined;
  const end = endOfDay(day);

  if (end === undefined) return "Pick a date, or leave it empty for a key that does not expire.";

  return end.getTime() > now
    ? undefined
    : "That day has passed. An expiry is today or a later day.";
};

/**
 * The `expires_at` to send for a typed expiry day: the end of that day in the browser's time zone, as ISO 8601;
 * `undefined` for no expiry (or a day `expiryProblem` refuses).
 */
export const expiryIso = (day: string, now: number): string | undefined => {
  if (expiryProblem(day, now) !== undefined) return undefined;

  return endOfDay(day)?.toISOString();
};

const pad = (value: number, width = 2): string => String(value).padStart(width, "0");

/** Today as `<input type="date" min>` reads it, in the browser's time zone. */
export const todayInput = (now: number): string => {
  const date = new Date(now);

  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

// ---------------------------------------------------------------------------------------------------------------
// Refused writes

/**
 * What a refused API key write says, by the server's error code. Codes without copy fall back to the server's own
 * explanation, then to the code.
 */
export const keyProblem = (error: string | undefined, message: string, detail?: string): string => {
  switch (error) {
    case "member_required":
      return "API keys are issued to members of the org, and you are not one. Add yourself as a member on the Members page first (platform admins and org owners can), or ask an org owner to.";
    case "invalid_name":
      return `A name is 1 to ${KEY_NAME_MAX} characters without control characters.`;
    case "invalid_expiry":
      return "An expiry has to be a time in the future.";
    case "too_many_keys":
      return `A member holds at most ${KEYS_PER_MEMBER} API keys. Revoke keys you no longer use, and ask an org admin if none is left to revoke.`;
    case "api_key_not_found":
      return "That key no longer exists. Reload to see the current list.";
    default:
      return detail === undefined ? message : asSentence(detail);
  }
};

/** Why the form is closed to the caller, when it is: they hold no role in the org, so the server would refuse. */
export const notMemberNote = (me: { readonly role: string | null }): string | undefined =>
  me.role === null ? keyProblem("member_required", "") : undefined;

// ---------------------------------------------------------------------------------------------------------------
// Using a key

/** How each family of clients sends an API key. */
export const KEY_HEADERS: ReadonlyArray<{
  readonly clients: string;
  readonly send: string;
}> = [
  { clients: "OpenAI-compatible clients", send: "Authorization: Bearer <key>" },
  { clients: "Claude", send: "x-api-key: <key>" },
  { clients: "Gemini", send: "x-goog-api-key: <key>, or ?key=<key> in the URL" },
];
