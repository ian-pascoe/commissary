// The Accounts page's selection and the per-account outcomes of its batch actions (`POST /credentials/batch`) and of
// "Check all quotas" (`POST /credentials/quota/all`). Pure: no DOM, tested in test/web-batch.test.ts.
//
// Accounts are keyed by file name (`entry.name`, the credential id the batch endpoint takes). Selection respects the
// list's filter and search: an action applies to the selected accounts that are shown, and "select all" selects what
// is shown. Accounts selected and then hidden by the filter stay selected (clearing the search brings them back) but
// are left out of the action, and the page says so. After an action the accounts that failed stay selected, so the
// operator can try again or act on them otherwise; the ones that succeeded are let go. A token refresh leaves out the
// accounts whose provider has none (and the server skips those without a refresh token); they stay selected too.
import type { AccountResult, BatchAction } from "#contract/credentials.ts";
import { refreshable } from "./accounts.ts";
import { asSentence } from "./failure.ts";

export type Selection = ReadonlySet<string>;

export const toggle = (selected: Selection, name: string): Selection => {
  const next = new Set(selected);

  if (!next.delete(name)) next.add(name);

  return next;
};

/** Selects every shown account, keeping the hidden ones already selected. */
export const selectShown = (selected: Selection, shown: ReadonlyArray<string>): Selection =>
  new Set([...selected, ...shown]);

/** Lets go of every shown account, keeping the hidden ones. */
export const clearShown = (selected: Selection, shown: ReadonlyArray<string>): Selection => {
  const next = new Set(selected);

  for (const name of shown) next.delete(name);

  return next;
};

/** What the select-all checkbox shows: none, some (indeterminate) or all of the shown accounts selected. */
export const shownState = (
  selected: Selection,
  shown: ReadonlyArray<string>,
): "none" | "some" | "all" => {
  const count = shown.filter((name) => selected.has(name)).length;

  if (count === 0) return "none";

  return count === shown.length ? "all" : "some";
};

/** Drops selected accounts that no longer exist (deleted here or elsewhere). */
export const keepExisting = (selected: Selection, existing: ReadonlyArray<string>): Selection => {
  const present = new Set(existing);
  const next = [...selected].filter((name) => present.has(name));

  return next.length === selected.size ? selected : new Set(next);
};

/** Splits names into requests the server accepts (`MAX_BATCH_NAMES` each). */
export const chunks = (
  names: ReadonlyArray<string>,
  size: number,
): ReadonlyArray<ReadonlyArray<string>> => {
  const out: Array<ReadonlyArray<string>> = [];

  for (let start = 0; start < names.length; start += Math.max(1, size)) {
    out.push(names.slice(start, start + Math.max(1, size)));
  }

  return out;
};

/** One batch request's outcome: the server's answer per account, or why the request as a whole failed. */
export type ChunkOutcome =
  | { readonly names: ReadonlyArray<string>; readonly results: ReadonlyArray<AccountResult> }
  | { readonly names: ReadonlyArray<string>; readonly failure: string };

export interface Failure {
  readonly name: string;
  /** Why, as a sentence. */
  readonly reason: string;
}

export interface Folded {
  readonly succeeded: ReadonlyArray<string>;
  readonly failed: ReadonlyArray<Failure>;
  /** The action did not apply to these (a token refresh of an account without a refresh token). */
  readonly skipped: ReadonlyArray<string>;
}

/**
 * An account's failure as the operator reads it. `provider`: the account's provider name, for a quota check the
 * provider refused (401/403).
 */
export const failureReason = (
  result: Pick<AccountResult, "error" | "message" | "status">,
  provider?: string,
  /** The account is a config provider key (no sign-in to refresh: the key itself was refused). */
  configKey = false,
): string => {
  switch (result.error) {
    case "not_found":
      return "It is no longer connected.";
    case "unavailable":
      return "The proxy could not reach its account store. Try again.";
    case "check_failed":
      if ((result.status === 401 || result.status === 403) && provider !== undefined && configKey)
        return `${provider} refused the provider key. Check it on the Keys page.`;

      if ((result.status === 401 || result.status === 403) && provider !== undefined)
        return `${provider} refused the saved sign-in. Refresh the tokens or reconnect.`;

      return asSentence(result.message ?? result.error);
    default:
      return asSentence(result.message ?? result.error ?? "");
  }
};

/**
 * Folds the outcomes of one action's requests into who succeeded, who failed and why, and who was skipped. A name the
 * server did not answer for counts as failed; a request that failed as a whole fails each of its names with its reason.
 */
export const foldOutcomes = (outcomes: ReadonlyArray<ChunkOutcome>): Folded => {
  const succeeded: string[] = [];
  const failed: Failure[] = [];
  const skipped: string[] = [];

  for (const outcome of outcomes) {
    if ("failure" in outcome) {
      for (const name of outcome.names) failed.push({ name, reason: outcome.failure });
      continue;
    }

    const answered = new Map(outcome.results.map((result) => [result.name, result]));

    for (const name of outcome.names) {
      const result = answered.get(name);

      if (result === undefined) failed.push({ name, reason: "The server did not answer for it." });
      else if (result.ok) succeeded.push(name);
      else if (result.skipped === true) skipped.push(name);
      else failed.push({ name, reason: failureReason(result) });
    }
  }

  return { succeeded, failed, skipped };
};

/** What an action sends: the selected accounts shown, minus those it cannot apply to. */
export interface Plan {
  /** The selected accounts the list shows, in its order: what the action is about (the delete dialog names them). */
  readonly acting: ReadonlyArray<string>;
  /** What the requests carry. */
  readonly send: ReadonlyArray<string>;
  /** Shown and selected, but the action does not apply (a token refresh of a provider without one). */
  readonly leftOut: ReadonlyArray<string>;
  /** Selected but hidden by the filter or search: not part of the action. */
  readonly hidden: number;
}

export const planAction = (
  action: BatchAction,
  selected: Selection,
  shown: ReadonlyArray<{ readonly entry: { readonly name: string; readonly provider: string } }>,
): Plan => {
  const picked = shown.filter((account) => selected.has(account.entry.name));
  const applies = (provider: string) => action !== "refresh" || refreshable(provider);

  const send: string[] = [];
  const leftOut: string[] = [];

  for (const { entry } of picked) (applies(entry.provider) ? send : leftOut).push(entry.name);

  return {
    acting: picked.map((account) => account.entry.name),
    send,
    leftOut,
    hidden: selected.size - picked.length,
  };
};

/**
 * The selection after an action over `sent`: those that succeeded are let go; the failed and the skipped stay
 * selected, as do the accounts the action left out or did not see (hidden).
 */
export const afterAction = (
  selected: Selection,
  sent: ReadonlyArray<string>,
  folded: Folded,
): Selection =>
  new Set([
    ...clearShown(selected, sent),
    ...folded.failed.map((failure) => failure.name),
    ...folded.skipped,
  ]);

const VERB: Record<BatchAction, { readonly done: string; readonly infinitive: string }> = {
  enable: { done: "Enabled", infinitive: "enable" },
  disable: { done: "Disabled", infinitive: "disable" },
  refresh: { done: "Refreshed the tokens of", infinitive: "refresh" },
  delete: { done: "Deleted", infinitive: "delete" },
};

const accounts = (count: number): string => `${count} account${count === 1 ? "" : "s"}`;

/** What the busy button says. */
export const busyLabel = (action: BatchAction): string => {
  switch (action) {
    case "enable":
      return "Enabling…";
    case "disable":
      return "Disabling…";
    case "refresh":
      return "Refreshing…";
    case "delete":
      return "Deleting…";
  }
};

/** What a result says: the part in ink (what was done), and the part that needs the operator (failures), in red. */
export interface Said {
  readonly done: string;
  readonly problem: string;
}

const joined = (...parts: ReadonlyArray<string>): string =>
  parts.filter((part) => part !== "").join(" ");

/** Said after a token refresh when some selected accounts have none; they were left out. */
export const skippedNote = (skipped: number): string => {
  if (skipped === 0) return "";

  return skipped === 1
    ? "1 account has no token refresh. It was left out and stays selected."
    : `${skipped} accounts have no token refresh. They were left out and stay selected.`;
};

/** What an action did to every account it was sent for, some or none; `skipped`: left out (see {@link skippedNote}). */
export const actionSummary = (action: BatchAction, folded: Folded, skipped: number = 0): Said => {
  const done = folded.succeeded.length;
  const failed = folded.failed.length;
  const verb = VERB[action];
  const note = skippedNote(skipped);

  if (failed === 0)
    return { done: joined(done === 0 ? "" : `${verb.done} ${accounts(done)}.`, note), problem: "" };

  if (done === 0) {
    return {
      done: note,
      problem: `Could not ${verb.infinitive} ${failed === 1 ? "the account" : `any of the ${accounts(failed)}`}. ${failed === 1 ? "It stays" : "They stay"} selected.`,
    };
  }

  return {
    done: joined(`${verb.done} ${done} of ${accounts(done + failed)}.`, note),
    problem: `${failed} failed and ${failed === 1 ? "stays" : "stay"} selected.`,
  };
};

/** The selected accounts the filter or search hides, which an action skips. */
export const hiddenNote = (hidden: number): string =>
  hidden === 1
    ? "1 more is selected but hidden by the filter. Actions skip it."
    : `${hidden} more are selected but hidden by the filter. Actions skip them.`;

/** What a failed account's row says under its name. */
export const rowFailure = (action: BatchAction, reason: string): string =>
  `Could not ${VERB[action].infinitive}. ${reason}`;

/** What a check of every quota did. */
export const sweepSummary = (checked: number, failed: number): Said => {
  const total = checked + failed;

  if (total === 0)
    return {
      done: "No enabled account reports quota, so there was nothing to check.",
      problem: "",
    };

  if (failed === 0) return { done: `Checked the quota of ${accounts(total)}.`, problem: "" };

  if (checked === 0) {
    return {
      done: "",
      problem: `The quota check failed for ${failed === 1 ? "the account" : `all ${accounts(failed)}`}.`,
    };
  }

  return {
    done: `Checked the quota of ${checked} of ${accounts(total)}.`,
    problem: `${failed} failed.`,
  };
};
