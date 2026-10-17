// How an account is named and what the operator needs to know about it, shared by the overview and the Accounts
// pages. Pure: no DOM, tested in test/quota.test.ts.
import type { CredentialEntry } from "@commissary/contract/credentials";
import { providerName } from "./providers.ts";
import { type AccountStanding, accountStanding, checksQuota } from "./quota.ts";

/** The server's mask before the last characters of a provider key (`[redacted]…abcd`). */
const KEY_MASK = /^\[redacted\]/;

/**
 * The account's address or label, whichever it has (the file name as a last resort); a provider key reads
 * "Key …abcd".
 */
export const accountName = (entry: CredentialEntry): string => {
  if (entry.source === "config" && entry.account !== undefined && KEY_MASK.test(entry.account))
    return `Key ${entry.account.replace(KEY_MASK, "").trim()}`;

  return (
    [entry.email, entry.account, entry.label].find(
      (name) => name !== undefined && name !== "" && name !== entry.provider,
    ) ?? entry.name
  );
};

export interface Assessed {
  readonly entry: CredentialEntry;
  readonly standing: AccountStanding;
  /** Closed or failing: the red trail mark beside the name. */
  readonly closed: boolean;
  /** What the operator needs to know, shown under the name ("Closed", "Failing: ..."); none when healthy. */
  readonly note: string | undefined;
  /** The note's tone: red when closed, ink when near the limit, stone when disabled. */
  readonly tone: "closed" | "near" | "disabled" | undefined;
}

export const assess = (entry: CredentialEntry): Assessed => {
  const standing = accountStanding(entry);

  if (entry.disabled) {
    return { entry, standing, closed: false, note: "Disabled", tone: "disabled" };
  }

  if (standing.cutOffUntil !== undefined) {
    return {
      entry,
      standing,
      closed: true,
      note: "Closed by the provider's rate limit",
      tone: "closed",
    };
  }

  if (entry.status === "error") {
    const detail = entry.status_message === "" ? "" : `: ${entry.status_message}`;

    return { entry, standing, closed: true, note: `Failing${detail}`, tone: "closed" };
  }

  if (standing.level === "near") {
    return { entry, standing, closed: false, note: "Near its limit", tone: "near" };
  }

  return { entry, standing, closed: false, note: undefined, tone: undefined };
};

/** The Accounts page's filters. */
export type AccountFilter = "all" | "attention" | "disabled";

const needsAttention = (account: Assessed): boolean =>
  !account.entry.disabled && (account.closed || account.tone === "near");

export const ACCOUNT_FILTERS: ReadonlyArray<{
  readonly id: AccountFilter;
  readonly label: string;
  readonly keep: (account: Assessed) => boolean;
}> = [
  { id: "all", label: "All", keep: () => true },
  { id: "attention", label: "Needs attention", keep: needsAttention },
  { id: "disabled", label: "Disabled", keep: (account) => account.entry.disabled },
];

/** Whether the account matches a search (`query` trimmed and lower-cased; empty matches all). */
export const matchesQuery = (account: Assessed, query: string): boolean => {
  if (query === "") return true;
  const { entry } = account;

  return [
    providerName(entry.provider),
    accountName(entry),
    entry.name,
    entry.note,
    entry.project_id,
    account.note,
  ].some((field) => field?.toLowerCase().includes(query) === true);
};

/** The accounts the list shows under a filter and a search, in the given order. */
export const shownAccounts = (
  accounts: ReadonlyArray<Assessed>,
  filter: AccountFilter,
  query: string,
): ReadonlyArray<Assessed> => {
  const keep = ACCOUNT_FILTERS.find((candidate) => candidate.id === filter)?.keep ?? (() => true);

  return accounts.filter((account) => keep(account) && matchesQuery(account, query));
};

/** Providers whose tokens the server can refresh on request (packages/models/src/credentials/refresh/registry.ts). */
const REFRESHABLE = new Set([
  "claude",
  "codex",
  "antigravity",
  "xai",
  "kimi",
  "kimi-ai",
  "meta",
  "vertex",
]);

export const refreshable = (provider: string): boolean => REFRESHABLE.has(provider);

/**
 * A provider key listed for its quota (`source: "config"`, OpenCode Go): it lives in the config, so it is edited,
 * disabled and removed on the Provider keys page, not here.
 */
export const isConfigAccount = (entry: CredentialEntry): boolean => entry.source === "config";

/** What the account page offers for an account; a config key keeps the quota check and the cooldowns only. */
export interface AccountActions {
  readonly checkQuota: boolean;
  readonly refresh: boolean;
  /** Enable or disable. */
  readonly toggle: boolean;
  /** The account's own routing fields (`AccountRouting.tsx`). */
  readonly routing: boolean;
  readonly remove: boolean;
}

export const accountActions = (entry: CredentialEntry): AccountActions => {
  const file = !isConfigAccount(entry);

  return {
    checkQuota: checksQuota(entry.provider),
    refresh: file && refreshable(entry.provider),
    toggle: file,
    routing: file,
    remove: file,
  };
};

/** Where a config account's key is edited: its group on the Provider keys page, else the Provider keys page itself. */
export type KeyHome =
  | { readonly to: "/keys/$family/$index"; readonly params: { family: string; index: string } }
  | { readonly to: "/keys" };

export const keyHome = (entry: CredentialEntry): KeyHome | undefined => {
  if (!isConfigAccount(entry)) return undefined;
  const group = entry.key_group;

  return group === undefined
    ? { to: "/keys" }
    : {
        to: "/keys/$family/$index",
        params: { family: group.family, index: String(group.index) },
      };
};

/** The accounts a selection can hold: batch actions (enable, disable, refresh, delete) apply to auth files only. */
export const selectable = <A extends { readonly entry: CredentialEntry }>(
  accounts: ReadonlyArray<A>,
): ReadonlyArray<A> => accounts.filter((account) => !isConfigAccount(account.entry));

/** A cooldown's reason as the operator reads it. */
export const cooldownReason = (reason: string): string => {
  switch (reason) {
    case "quota":
      return "Rate limit";
    case "credential_quota":
      return "Account quota used up";
    case "cloudflare_challenge":
      return "Blocked by a Cloudflare challenge";
    case "unknown":
      return "Unknown";
    default:
      return reason;
  }
};
