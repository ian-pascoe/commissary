// The Models page's catalog line and "Refresh catalog" button: what is said about the model catalog (when it was
// refreshed and from where), when the button is off and why, and how a refresh's outcome reads. Pure; tested in
// test/catalog.test.ts.
import type { CatalogRefresh, CatalogStatus } from "@commissary/contract/catalog";
import { formatAgo } from "./format.ts";

const at = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined;
  const parsed = Date.parse(raw);

  return Number.isNaN(parsed) ? undefined : parsed;
};

/** Where the catalog is fetched from: models.dev, or the host of the custom address. */
export const catalogSource = (status: CatalogStatus): string =>
  status.mode === "custom" ? (status.source_host ?? "a custom address") : "models.dev";

/** The line under the page title: "Catalog refreshed 2 h ago · from models.dev". */
export const catalogLine = (status: CatalogStatus, now: number): string => {
  if (status.mode === "embed") return "Catalog: embedded copy · never fetched";

  const refreshed = at(status.refreshed_at);

  if (status.mode === "disabled" && status.source_problem !== undefined)
    return `Catalog refresh is off · ${status.source_problem}`;

  if (status.mode === "disabled")
    return status.stored && refreshed !== undefined
      ? `Catalog refresh is off · last refreshed ${formatAgo(Math.max(0, now - refreshed))}`
      : "Catalog refresh is off · shipped copy";

  const from = `from ${catalogSource(status)}`;

  if (!status.stored || refreshed === undefined) return `Catalog: shipped copy · ${from}`;

  return `Catalog refreshed ${formatAgo(Math.max(0, now - refreshed))} · ${from}`;
};

/** A refresh that failed after the stored catalog was last confirmed, said under the line. */
export const catalogProblem = (status: CatalogStatus): string | undefined => {
  const attempt = status.last_attempt;

  if (attempt === undefined || attempt.status !== "failed") return undefined;
  const refreshed = at(status.refreshed_at);
  const attempted = at(attempt.at);

  if (refreshed !== undefined && attempted !== undefined && attempted <= refreshed)
    return undefined;

  return `The last refresh failed${attempt.message === undefined ? "" : `: ${attempt.message}`}. The catalog in use is unchanged.`;
};

/** Why the button is off: the source setting means nothing is fetched. `undefined` while it can be pressed. */
export const refreshHint = (status: CatalogStatus): string | undefined => {
  if (status.mode === "disabled" && status.source_problem !== undefined)
    return `The catalog source is not usable: ${status.source_problem}. Change it in Settings to refresh.`;

  if (status.mode === "embed")
    return "The catalog source is Embedded copy, which is never fetched. Change it in Settings to refresh.";

  if (status.mode === "disabled")
    return "Catalog refresh is Off. Change the catalog source in Settings to refresh.";

  return undefined;
};

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`;

/** What `useAction` hands back for a refresh (`Outcome` in use-action.ts, which needs React): a value or a failure. */
export type RefreshAttempt =
  | { readonly ok: true; readonly value: CatalogRefresh }
  | {
      readonly ok: false;
      readonly message: string;
      readonly error: string | undefined;
      readonly detail?: string;
    };

export interface RefreshNote {
  readonly tone: "done" | "problem";
  readonly text: string;
}

/** A finished refresh, as said next to the button. */
export const refreshNote = (outcome: RefreshAttempt): RefreshNote => {
  if (!outcome.ok) {
    if (outcome.error === "catalog_refresh_running")
      return {
        tone: "problem",
        text: "A refresh is already running. Wait a moment, then try again.",
      };

    return {
      tone: "problem",
      text: `Could not refresh the catalog. ${outcome.detail ?? outcome.message}`,
    };
  }

  const { status, added, removed, skipped, message } = outcome.value;

  if (status === "failed")
    return {
      tone: "problem",
      text: `Refresh failed${message === undefined ? "" : `: ${message}`}. The catalog in use is unchanged.`,
    };

  if (status === "unchanged") return { tone: "done", text: "The catalog is already up to date." };

  const changes = [
    added === undefined || added === 0 ? undefined : `${plural(added, "model")} added`,
    removed === undefined || removed === 0 ? undefined : `${plural(removed, "model")} removed`,
  ].filter((part) => part !== undefined);

  const left =
    skipped === undefined || skipped === 0
      ? ""
      : ` ${plural(skipped, "entry", "entries")} in the document could not be read and ${skipped === 1 ? "was" : "were"} left out.`;

  return {
    tone: "done",
    text: `Catalog updated: ${changes.length === 0 ? "no served models changed" : changes.join(", ")}.${left}`,
  };
};
