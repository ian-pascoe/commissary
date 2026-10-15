// Accounts: every connected account by provider, with a filter for those that need attention or are disabled and a
// search; each row opens the account. Connecting starts here too, from the head's Connect account.
//
// "Check all quotas" in the head asks every enabled account's provider for its allowance now (`POST
// /credentials/quota/all`) and lists the accounts whose check failed.
//
// "Select" turns the list into a selection: a checkbox column, rows that toggle instead of opening, and a bar
// pinned to the bottom of the window with the count and the actions (enable, disable, refresh tokens, and delete set
// apart, behind a confirmation that names every account). An action applies to the selected accounts the filter and
// search show (a token refresh leaves out the accounts that have none); the result says who failed and why, on the bar
// and on each failed row, and those stay selected. The delete confirmation stays open until the deletion settles.
// Escape, the bar's Done or the toggle (then reading Done) leaves the selection, focus returning to the toggle.
//
// Config provider keys whose provider reports quota (OpenCode Go) are listed too, marked "Config key": they take the quota
// check like any account but live in the config, so a selection leaves them out (their row keeps opening the account,
// which links to the key's group on the Provider keys page).
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import {
  ChevronRight,
  Gauge,
  ListChecks,
  type LucideIcon,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { type ReactNode, useDeferredValue, useEffect, useId, useRef, useState } from "react";
import type { BatchAction } from "#contract/credentials.ts";
import {
  batchAtom,
  CREDENTIALS,
  checkAllQuotasAtom,
  credentialsAtom,
  nowAtom,
} from "../api/client.ts";
import { kit, Problem } from "../components/Kit.tsx";
import { Meter } from "../components/Meter.tsx";
import { TrailMark } from "../components/Signs.tsx";
import {
  ACCOUNT_FILTERS,
  type AccountFilter,
  type Assessed,
  accountName,
  assess,
  isConfigAccount,
  refreshable,
  selectable,
  shownAccounts,
} from "../lib/accounts.ts";
import {
  actionSummary,
  afterAction,
  busyLabel,
  clearShown,
  type Failure,
  type Folded,
  failureReason,
  hiddenNote,
  keepExisting,
  planAction,
  rowFailure,
  type Said,
  type Selection,
  selectShown,
  shownState,
  sweepSummary,
  toggle,
} from "../lib/batch.ts";
import { failureMessage } from "../lib/failure.ts";
import { formatCount, formatDuration } from "../lib/format.ts";
import { providerName } from "../lib/providers.ts";
import { checksQuota, windowLevel, windowPace } from "../lib/quota.ts";
import { resetsBrief } from "../lib/reset-grants.ts";
import { useAction } from "../lib/use-action.ts";
import { holdsOnlyPrivate } from "../lib/role.ts";
import { usePageTitle } from "../lib/use-page-title.ts";
import { useRole } from "../lib/use-role.ts";
import styles from "./Accounts.module.css";
import { OtherPrivateAccounts } from "./AccountsOthers.tsx";

/** Requests per account are counted over the recent-requests ring: ten-minute buckets. */
const BUCKET_MS = 10 * 60_000;

/** Accounts the delete confirmation names one by one before "and n more". */
const NAMED_IN_DIALOG = 8;

/** Failed accounts a result names one by one before "and n more"; the rest are marked in the list. */
const NAMED_IN_RESULT = 5;

const byProviderThenName = (a: Assessed, b: Assessed): number =>
  providerName(a.entry.provider).localeCompare(providerName(b.entry.provider)) ||
  accountName(a.entry).localeCompare(accountName(b.entry));

const fullName = (account: Assessed): string =>
  `${providerName(account.entry.provider)} · ${accountName(account.entry)}`;

const plural = (count: number, one: string, many: string = `${one}s`): string =>
  `${formatCount(count)} ${count === 1 ? one : many}`;

// ---------------------------------------------------------------------------------------------------------------
// Outcomes

interface Outcome extends Said {
  readonly failures?: ReadonlyArray<{ readonly label: string; readonly reason: string }>;
}

/**
 * What an action or a check said: what was done in ink, what needs the operator in red with the trail mark, then the
 * accounts that failed, each with its reason.
 */
const OutcomeLines = ({ outcome }: { readonly outcome: Outcome }) => {
  const failures = outcome.failures ?? [];
  const named = failures.slice(0, NAMED_IN_RESULT);

  return (
    <div className={styles["outcome"]}>
      {outcome.done === "" ? null : <p className={styles["outcomeLine"]}>{outcome.done}</p>}
      {outcome.problem === "" ? null : (
        <p className={styles["problemLine"]}>
          <TrailMark />
          {outcome.problem}
        </p>
      )}
      {named.length === 0 ? null : (
        <ul className={styles["failures"]}>
          {named.map((failure) => (
            <li key={failure.label}>
              <span className={styles["failedName"]}>{failure.label}:</span> {failure.reason}
            </li>
          ))}
          {failures.length > named.length ? (
            <li className={styles["more"]}>
              and {plural(failures.length - named.length, "more")}, marked in the list
            </li>
          ) : null}
        </ul>
      )}
    </div>
  );
};

const labelled = (
  failures: ReadonlyArray<Failure>,
  labels: ReadonlyMap<string, string>,
): ReadonlyArray<{ readonly label: string; readonly reason: string }> =>
  failures.map((failure) => ({
    label: labels.get(failure.name) ?? failure.name,
    reason: failure.reason,
  }));

// ---------------------------------------------------------------------------------------------------------------
// Check all quotas

const CheckAllQuotas = ({ accounts }: { readonly accounts: ReadonlyArray<Assessed> }) => {
  const check = useAction(checkAllQuotasAtom);
  const [outcome, setOutcome] = useState<Outcome | undefined>(undefined);

  const checkable = accounts.filter(
    (account) => !account.entry.disabled && checksQuota(account.entry.provider),
  );

  if (checkable.length === 0) return null;

  const run = async () => {
    setOutcome(undefined);
    const byName = new Map(accounts.map((account) => [account.entry.name, account]));
    const result = await check.run({ reactivityKeys: CREDENTIALS });

    if (result.ok) {
      const { checked, failed, results } = result.value;

      const failures = results.flatMap((item) => {
        if (item.ok) return [];
        const account = byName.get(item.name);

        return [
          {
            label: account === undefined ? item.name : fullName(account),
            reason: failureReason(
              item,
              account === undefined ? undefined : providerName(account.entry.provider),
              account !== undefined && isConfigAccount(account.entry),
            ),
          },
        ];
      });

      setOutcome({ ...sweepSummary(checked, failed), failures });
    } else if (result.error === "quota_check_running") {
      setOutcome({
        done: "Another check of every quota is already running. The figures update as it finishes.",
        problem: "",
      });
    } else {
      setOutcome({ done: "", problem: `Could not check the quotas. ${result.message}` });
    }
  };

  return (
    <>
      <button
        type="button"
        className={kit["secondary"]}
        disabled={check.busy}
        aria-busy={check.busy}
        onClick={() => void run()}
      >
        <Gauge
          aria-hidden="true"
          size={16}
          strokeWidth={2.25}
          className={check.busy ? kit["spinning"] : undefined}
        />
        {check.busy ? "Checking…" : "Check all quotas"}
      </button>
      <div
        className={styles["sweep"]}
        role="status"
        data-started={check.busy || outcome !== undefined}
      >
        {check.busy ? (
          <p className={`${styles["outcomeLine"]} ${styles["pendingLine"]}`}>
            Asking the providers about {plural(checkable.length, "account")}…
          </p>
        ) : outcome === undefined ? null : (
          <OutcomeLines outcome={outcome} />
        )}
      </div>
    </>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// Rows

interface RowSelection {
  readonly checked: boolean;
  readonly onToggle: () => void;
  /** Why the last action failed for this account. */
  readonly failure: string | undefined;
}

const Row = ({
  account,
  selecting,
  selection,
}: {
  readonly account: Assessed;
  /** The list is a selection. */
  readonly selecting: boolean;
  /** Set while the list is a selection and the account can be selected (not a config key). */
  readonly selection: RowSelection | undefined;
}) => {
  const { entry, standing, closed, note, tone } = account;
  const config = isConfigAccount(entry);
  const navigate = useNavigate();
  const pickId = useId();
  const requests = entry.recent_requests.reduce((sum, bucket) => sum + bucket.success, 0);
  const failed = entry.recent_requests.reduce((sum, bucket) => sum + bucket.failed, 0);
  const now = useAtomValue(nowAtom);
  const resets = resetsBrief(entry.reset_grants, now);

  return (
    <tr
      className={styles["row"]}
      data-disabled={entry.disabled}
      data-selecting={selection !== undefined}
      data-selected={selection?.checked === true}
      onClick={(event) => {
        if (event.target instanceof Element && event.target.closest("a, label, input") !== null)
          return;

        if (selection === undefined) {
          void navigate({ to: "/accounts/$authIndex", params: { authIndex: entry.auth_index } });
        } else {
          selection.onToggle();
        }
      }}
    >
      {selecting && selection === undefined ? (
        <td className={styles["pick"]}>
          <span className={kit["visuallyHidden"]}>A config key: not part of a selection</span>
        </td>
      ) : null}
      {selection === undefined ? null : (
        <td className={styles["pick"]}>
          <input
            id={pickId}
            type="checkbox"
            className={styles["check"]}
            checked={selection.checked}
            onChange={selection.onToggle}
            aria-labelledby={`${pickId}-provider ${pickId}-address`}
            aria-describedby={selection.failure === undefined ? undefined : `${pickId}-failure`}
          />
        </td>
      )}
      <th scope="row" className={styles["accountCell"]}>
        <div className={styles["account"]}>
          <span className={styles["markSlot"]}>{closed ? <TrailMark /> : null}</span>
          <span className={styles["who"]}>
            <span id={`${pickId}-provider`} className={styles["provider"]}>
              {providerName(entry.provider)}
              {config ? <span className={styles["source"]}>Config key</span> : null}
              {entry.private === true ? <span className={styles["source"]}>Private</span> : null}
            </span>
            {selection === undefined ? (
              <Link
                to="/accounts/$authIndex"
                params={{ authIndex: entry.auth_index }}
                className={styles["address"]}
              >
                {accountName(entry)}
              </Link>
            ) : (
              <label id={`${pickId}-address`} htmlFor={pickId} className={styles["address"]}>
                {accountName(entry)}
              </label>
            )}
            {note === undefined ? null : (
              <span className={styles["note"]} data-tone={tone}>
                {note}
              </span>
            )}
            {selection?.failure === undefined ? null : (
              <span id={`${pickId}-failure`} className={styles["rowFailure"]}>
                {selection.failure}
              </span>
            )}
          </span>
        </div>
      </th>
      <td className={styles["quota"]}>
        {standing.windows.length === 0 ? (
          entry.quota_report?.error !== undefined && checksQuota(entry.provider) ? (
            <span className={styles["checkFailed"]}>
              <TrailMark />
              The last quota check failed
            </span>
          ) : (
            <span className={kit["muted"]}>
              {checksQuota(entry.provider) ? "No figures yet" : "Not reported"}
            </span>
          )
        ) : (
          <div className={styles["meters"]}>
            {standing.windows.map((window) => (
              <Meter
                key={window.label}
                label={window.label}
                percent={window.usedPercent}
                level={windowLevel(window)}
                pace={windowPace(window, standing.readAt, now)}
              />
            ))}
          </div>
        )}
        {resets === undefined ? null : (
          <span className={styles["resets"]} data-tone={resets.tone}>
            {resets.text}
          </span>
        )}
      </td>
      <td className={`${styles["number"]} ${styles["priority"]}`}>
        {entry.priority === undefined ? (
          <span className={kit["muted"]}>0</span>
        ) : (
          formatCount(entry.priority)
        )}
      </td>
      <td className={`${styles["number"]} ${styles["requests"]}`}>
        <span className={styles["count"]}>{formatCount(requests + failed)}</span>
        {failed > 0 ? <span className={styles["failed"]}>{formatCount(failed)} failed</span> : null}
      </td>
      <td className={styles["go"]} aria-hidden="true">
        {selection === undefined ? <ChevronRight size={18} strokeWidth={2.25} /> : null}
      </td>
    </tr>
  );
};

/** The select-all checkbox of the shown accounts, with its indeterminate state. */
const PickAll = ({
  state,
  onChange,
}: {
  readonly state: "none" | "some" | "all";
  readonly onChange: () => void;
}) => {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (ref.current !== null) ref.current.indeterminate = state === "some";
  }, [state]);

  return (
    <input
      ref={ref}
      type="checkbox"
      className={styles["check"]}
      aria-label="Select every shown account"
      checked={state === "all"}
      onChange={onChange}
    />
  );
};

// ---------------------------------------------------------------------------------------------------------------
// The selection bar and the delete confirmation

interface LastAction {
  readonly action: BatchAction;
  readonly folded: Folded;
  readonly labels: ReadonlyMap<string, string>;
  /** Selected accounts the action did not apply to (no token refresh); they stay selected. */
  readonly skipped: number;
}

const ActionButton = ({
  action,
  icon: Icon,
  label,
  busy,
  disabled,
  onClick,
  danger = false,
}: {
  readonly action: BatchAction;
  readonly icon: LucideIcon;
  readonly label: string;
  readonly busy: BatchAction | undefined;
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly danger?: boolean;
}) => (
  <button
    type="button"
    className={danger ? kit["danger"] : kit["secondary"]}
    disabled={disabled || busy !== undefined}
    aria-busy={busy === action}
    onClick={onClick}
  >
    <Icon
      aria-hidden="true"
      size={16}
      strokeWidth={2.25}
      className={busy === action && action !== "delete" ? kit["spinning"] : undefined}
    />
    {busy === action ? busyLabel(action) : label}
  </button>
);

const ConfirmDelete = ({
  dialog,
  accounts,
  busy,
  onConfirm,
}: {
  readonly dialog: React.RefObject<HTMLDialogElement | null>;
  readonly accounts: ReadonlyArray<Assessed>;
  readonly busy: boolean;
  /** Runs the deletion; the dialog stays open, saying so, until it settles. */
  readonly onConfirm: () => Promise<void>;
}) => {
  const titleId = useId();
  const named = accounts.slice(0, NAMED_IN_DIALOG);
  const count = accounts.length;

  return (
    <dialog ref={dialog} className={kit["dialog"]} aria-labelledby={titleId}>
      <form
        method="dialog"
        className={kit["dialogBody"]}
        onSubmit={async (event) => {
          event.preventDefault();
          await onConfirm();
          dialog.current?.close();
        }}
      >
        <h2 id={titleId} className={kit["dialogTitle"]}>
          Delete {count === 1 ? "this account" : `these ${formatCount(count)} accounts`}?
        </h2>
        <ul className={styles["doomed"]}>
          {named.map((account) => (
            <li key={account.entry.name}>
              <span className={styles["doomedProvider"]}>
                {providerName(account.entry.provider)}
              </span>{" "}
              {accountName(account.entry)}
            </li>
          ))}
          {count > named.length ? (
            <li className={styles["more"]}>and {plural(count - named.length, "more")}</li>
          ) : null}
        </ul>
        <p>
          Requests stop going to {count === 1 ? "it" : "them"} and {count === 1 ? "its" : "their"}{" "}
          tokens are removed from Commissary. You can connect {count === 1 ? "it" : "them"} again
          later.
        </p>
        <div className={kit["dialogActions"]}>
          <button type="submit" className={kit["danger"]} disabled={busy} aria-busy={busy}>
            <Trash2 aria-hidden="true" size={16} strokeWidth={2.25} />
            {busy ? "Deleting…" : `Delete ${plural(count, "account")}`}
          </button>
          <button
            type="button"
            className={kit["secondary"]}
            disabled={busy}
            onClick={() => dialog.current?.close()}
          >
            Keep {count === 1 ? "it" : "them"}
          </button>
        </div>
      </form>
    </dialog>
  );
};

const SelectionBar = ({
  shown,
  selected,
  onSelect,
  last,
  busy,
  onAction,
  onDone,
}: {
  readonly shown: ReadonlyArray<Assessed>;
  readonly selected: Selection;
  readonly onSelect: (next: Selection) => void;
  readonly last: LastAction | undefined;
  readonly busy: BatchAction | undefined;
  readonly onAction: (action: BatchAction) => Promise<void>;
  readonly onDone: () => void;
}) => {
  const dialog = useRef<HTMLDialogElement>(null);
  const result = useRef<HTMLDivElement>(null);
  const shownNames = shown.map((account) => account.entry.name);
  const { acting: names, hidden } = planAction("delete", selected, shown);
  const picked = new Set(names);
  const acting = shown.filter((account) => picked.has(account.entry.name));
  const state = shownState(selected, shownNames);

  const outcome: Outcome | undefined =
    last === undefined
      ? undefined
      : {
          ...actionSummary(last.action, last.folded, last.skipped),
          failures: labelled(last.folded.failed, last.labels),
        };

  return (
    <div className={styles["bar"]} role="region" aria-label="Selected accounts">
      <div role="status" className={styles["barOutcome"]} ref={result} tabIndex={-1}>
        {outcome === undefined ? null : <OutcomeLines outcome={outcome} />}
      </div>
      <div className={styles["barRow"]}>
        <div className={styles["barCount"]}>
          <p>
            <span className={styles["selectedCount"]}>{formatCount(names.length)} selected</span>
            {hidden > 0 ? (
              <span className={styles["hiddenCount"]}> {hiddenNote(hidden)}</span>
            ) : null}
          </p>
          <div className={styles["barPicks"]}>
            {state === "all" ? null : (
              <button
                type="button"
                className={styles["textButton"]}
                onClick={() => onSelect(selectShown(selected, shownNames))}
              >
                Select all {formatCount(shown.length)} shown
              </button>
            )}
            {names.length === 0 ? null : (
              <button
                type="button"
                className={styles["textButton"]}
                onClick={() => onSelect(clearShown(selected, shownNames))}
              >
                Clear
              </button>
            )}
            <button type="button" className={styles["textButton"]} onClick={onDone}>
              Done
            </button>
          </div>
        </div>
        <div className={styles["barActions"]}>
          <ActionButton
            action="enable"
            icon={Power}
            label="Enable"
            busy={busy}
            disabled={!acting.some((account) => account.entry.disabled)}
            onClick={() => void onAction("enable")}
          />
          <ActionButton
            action="disable"
            icon={PowerOff}
            label="Disable"
            busy={busy}
            disabled={!acting.some((account) => !account.entry.disabled)}
            onClick={() => void onAction("disable")}
          />
          <ActionButton
            action="refresh"
            icon={RefreshCw}
            label="Refresh tokens"
            busy={busy}
            disabled={!acting.some((account) => refreshable(account.entry.provider))}
            onClick={() => void onAction("refresh")}
          />
          <span className={styles["barRule"]} aria-hidden="true" />
          <ActionButton
            action="delete"
            icon={Trash2}
            label="Delete…"
            busy={busy}
            disabled={acting.length === 0}
            onClick={() => dialog.current?.showModal()}
            danger
          />
        </div>
      </div>
      <ConfirmDelete
        dialog={dialog}
        accounts={acting}
        busy={busy !== undefined}
        onConfirm={async () => {
          await onAction("delete");
          result.current?.focus();
        }}
      />
    </div>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// The list

const List = ({ accounts }: { readonly accounts: ReadonlyArray<Assessed> }) => {
  const [filter, setFilter] = useState<AccountFilter>("all");
  const [search, setSearch] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Selection>(() => new Set());
  const [last, setLast] = useState<LastAction | undefined>(undefined);
  const [busy, setBusy] = useState<BatchAction | undefined>(undefined);
  const batch = useAction(batchAtom);
  const selectToggle = useRef<HTMLButtonElement>(null);
  const query = useDeferredValue(search.trim().toLowerCase());
  const searchId = useId();
  const listed = shownAccounts(accounts, filter, query);
  // What a selection and its actions see: the shown auth files (config keys are edited on the Provider keys page).
  const shown = selectable(listed);

  // Accounts deleted here or elsewhere leave the selection.
  const selected = keepExisting(
    picked,
    accounts.map((account) => account.entry.name),
  );

  const span = formatDuration(
    Math.max(1, ...accounts.map((account) => account.entry.recent_requests.length)) * BUCKET_MS,
  );

  const leave = () => {
    setSelecting(false);
    setPicked(new Set());
    setLast(undefined);
    selectToggle.current?.focus();
  };

  useEffect(() => {
    if (!selecting) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;

      // Escape belongs to an open dialog, and to a search field that still has text to clear.
      if (document.querySelector("dialog[open]") !== null) return;

      if (
        event.target instanceof HTMLInputElement &&
        event.target.type === "search" &&
        event.target.value !== ""
      )
        return;
      leave();
    };

    document.addEventListener("keydown", onKey);

    return () => document.removeEventListener("keydown", onKey);
  }, [selecting]);

  const act = async (action: BatchAction) => {
    const plan = planAction(action, selected, shown);
    const labels = new Map(shown.map((account) => [account.entry.name, fullName(account)]));
    setLast(undefined);
    setBusy(action);

    const outcome = await batch.run({ action, names: plan.send });

    setBusy(undefined);

    const folded: Folded = outcome.ok
      ? outcome.value
      : {
          succeeded: [],
          failed: plan.send.map((name) => ({ name, reason: outcome.message })),
          skipped: [],
        };

    // The accounts left out (no token refresh) were not sent: they stay selected, untouched.
    setPicked((current) => afterAction(current, plan.send, folded));
    setLast({ action, folded, labels, skipped: plan.leftOut.length + folded.skipped.length });
  };

  const failures = new Map(
    last === undefined
      ? []
      : last.folded.failed.map((failure) => [
          failure.name,
          rowFailure(last.action, failure.reason),
        ]),
  );

  const shownNames = shown.map((account) => account.entry.name);

  return (
    <>
      <div className={styles["toolbar"]}>
        <div className={kit["tabs"]} role="radiogroup" aria-label="Show">
          {ACCOUNT_FILTERS.map((candidate) => {
            const count = accounts.filter(candidate.keep).length;

            return (
              <button
                key={candidate.id}
                type="button"
                role="radio"
                aria-checked={filter === candidate.id}
                className={kit["tab"]}
                onClick={() => setFilter(candidate.id)}
              >
                {candidate.label}
                <span className={kit["tabCount"]}>{formatCount(count)}</span>
              </button>
            );
          })}
        </div>
        <div className={styles["tools"]}>
          <div className={styles["search"]}>
            <label htmlFor={searchId} className={kit["visuallyHidden"]}>
              Search accounts
            </label>
            <Search
              aria-hidden="true"
              size={16}
              strokeWidth={2.25}
              className={styles["searchIcon"]}
            />
            <input
              id={searchId}
              type="search"
              className={kit["input"]}
              placeholder="Search accounts"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <button
            type="button"
            ref={selectToggle}
            className={`${kit["secondary"]} ${styles["selectToggle"]}`}
            onClick={() => (selecting ? leave() : setSelecting(true))}
          >
            <ListChecks aria-hidden="true" size={16} strokeWidth={2.25} />
            {selecting ? "Done" : "Select"}
          </button>
        </div>
      </div>
      {listed.length === 0 ? (
        <p className={styles["empty"]}>
          {query === ""
            ? filter === "attention"
              ? "Nothing needs attention: every active account is taking requests."
              : "No disabled accounts."
            : `No account matches “${search.trim()}”.`}
        </p>
      ) : (
        <div className={styles["listBlock"]}>
          <p className={styles["mobileKey"]} aria-hidden="true">
            Requests, last {span}
          </p>
          <table className={styles["accounts"]} data-selecting={selecting}>
            <thead>
              <tr>
                {selecting ? (
                  <th scope="col" className={styles["pick"]}>
                    <PickAll
                      state={shownState(selected, shownNames)}
                      onChange={() =>
                        setPicked(
                          shownState(selected, shownNames) === "all"
                            ? clearShown(selected, shownNames)
                            : selectShown(selected, shownNames),
                        )
                      }
                    />
                  </th>
                ) : null}
                <th scope="col" className={styles["colAccount"]}>
                  Account
                </th>
                <th scope="col" className={styles["colQuota"]}>
                  Allowance used
                </th>
                <th scope="col" className={styles["number"]}>
                  Priority
                </th>
                <th scope="col" className={styles["number"]}>
                  Requests, last {span}
                </th>
                <th scope="col">
                  <span className={kit["visuallyHidden"]}>Open</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {listed.map((account) => (
                <Row
                  key={account.entry.id}
                  account={account}
                  selecting={selecting}
                  selection={
                    selecting && !isConfigAccount(account.entry)
                      ? {
                          checked: selected.has(account.entry.name),
                          onToggle: () =>
                            setPicked((current) => toggle(current, account.entry.name)),
                          failure: failures.get(account.entry.name),
                        }
                      : undefined
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selecting ? (
        <SelectionBar
          shown={shown}
          selected={selected}
          onSelect={setPicked}
          last={last}
          busy={busy}
          onAction={act}
          onDone={leave}
        />
      ) : null}
    </>
  );
};

/** The page's title, with Connect account (the panel's only way in to connecting) and any other actions. */
const Head = ({ children }: { readonly children?: ReactNode }) => (
  <header className={styles["head"]}>
    <h1 className={styles["title"]}>Accounts</h1>
    {children}
    <Link to="/accounts/connect" className={kit["primary"]}>
      <Plus aria-hidden="true" size={16} strokeWidth={2.5} />
      Connect account
    </Link>
  </header>
);

/** A plain member's page is theirs alone: say so, and what the org's admins can tell of it. */
const OwnLead = () => {
  const role = useRole();

  if (role.kind !== "ready" || !holdsOnlyPrivate(role.caller)) return null;

  return (
    <p className={styles["empty"]}>
      Your private accounts: only your own requests use them. Org admins see that each exists, its
      provider and its label, and nothing of how you use it.
    </p>
  );
};

export const AccountsPage = () => {
  usePageTitle("Accounts");
  const result = useAtomValue(credentialsAtom);
  const retry = useAtomRefresh(credentialsAtom);

  return (
    <div className={styles["page"]}>
      {AsyncResult.match(result, {
        onInitial: () => (
          <>
            <Head />
            <p className={kit["muted"]} aria-busy="true">
              Loading accounts…
            </p>
          </>
        ),
        onFailure: (failure) => (
          <>
            <Head />
            <Problem onRetry={retry}>Could not load accounts. {failureMessage(failure)}</Problem>
          </>
        ),
        onSuccess: ({ value }) => {
          const others = value.others ?? [];

          if (value.files.length === 0) {
            return (
              <>
                <Head />
                <OwnLead />
                <p className={styles["empty"]}>
                  No accounts yet. Connect one to let Commissary answer requests with it.
                </p>
                <OtherPrivateAccounts others={others} />
              </>
            );
          }

          const accounts = value.files.map(assess).toSorted(byProviderThenName);

          return (
            <>
              <Head>
                <CheckAllQuotas accounts={accounts} />
              </Head>
              <OwnLead />
              <List accounts={accounts} />
              <OtherPrivateAccounts others={others} />
            </>
          );
        },
      })}
    </div>
  );
};
