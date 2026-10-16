// The Account page's Routing section: the account's own auth-file fields (priority, weight, retry rounds, cooling,
// WebSocket preference, model prefix, exclusions, aliases, extra headers, note) as one form. The draft holds only the
// touched inputs (`lib/account-fields.ts`); while it differs from the account the head counts the changes and a
// sticky bar offers Save / Discard, and leaving the page asks first. A save sends only the changed fields; a value the
// server refuses (422) lands under its field, which takes the focus. Fields that do not apply to the provider are not
// shown. Secret header values stay masked: a header keeps its mask until the operator replaces the value.
import { Link, useBlocker } from "@tanstack/react-router";
import { Plus, X } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { CredentialEntry } from "@commissary/contract/credentials";
import { CREDENTIALS, patchFieldsAtom } from "../api/client.ts";
import { kit, Problem } from "../components/Kit.tsx";
import {
  type AliasRow,
  appliesTo,
  changedFields,
  changesText,
  type Cooling,
  draftErrors,
  type Draft,
  type Edits,
  FIELD_ORDER,
  type FieldErrors,
  type FieldKey,
  type HeaderRow,
  type FieldError,
  isSecretRow,
  maskTail,
  patchOf,
  prefixOf,
  rebaseEdits,
  rowId,
  serverError,
  shownDraft,
} from "../lib/account-fields.ts";
import { providerName } from "../lib/providers.ts";
import { useAction } from "../lib/use-action.ts";
import styles from "./AccountRouting.module.css";

/** How long the head says "Saved". */
const SAVED_FOR_MS = 6000;

const fieldId = (key: FieldKey): string => `routing-${key}`;

const sentence = (text: string): string =>
  `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? "" : "."}`;

/** Focus a control and bring it to the middle of the screen, clear of the sticky bar. */
const focusClear = (element: HTMLElement | null | undefined) => {
  if (element === null || element === undefined) return;
  element.focus({ preventScroll: true });
  element.scrollIntoView({ block: "center" });
};

/** The field's own control, or the first control of the row an error names, or of a group (aliases, headers). */
const focusField = (key: FieldKey, row?: string) => {
  requestAnimationFrame(() => {
    const target = document.getElementById(fieldId(key));
    const scope = row === undefined ? target : target?.querySelector(`[data-row="${row}"]`);

    focusClear(
      target instanceof HTMLFieldSetElement
        ? (scope ?? target).querySelector<HTMLElement>("input, button")
        : target,
    );
  });
};

// ---------------------------------------------------------------------------------------------------------------
// Controls

const Notes = ({
  id,
  hint,
  error,
}: {
  readonly id: string;
  readonly hint: ReactNode;
  readonly error: string | undefined;
}) => (
  <>
    {hint === undefined ? null : (
      <span id={`${id}-hint`} className={styles["hint"]}>
        {hint}
      </span>
    )}
    {error === undefined ? null : (
      <span id={`${id}-error`} className={kit["fieldError"]}>
        {error}
      </span>
    )}
  </>
);

const describedBy = (
  id: string,
  hint: ReactNode,
  error: FieldError | string | undefined,
): string | undefined =>
  [hint === undefined ? "" : `${id}-hint`, error === undefined ? "" : `${id}-error`]
    .filter((part) => part !== "")
    .join(" ") || undefined;

const TextField = ({
  field,
  label,
  hint,
  value,
  error,
  width = "short",
  numeric = false,
  placeholder,
  onChange,
}: {
  readonly field: FieldKey;
  readonly label: string;
  readonly hint?: ReactNode;
  readonly value: string;
  readonly error: string | undefined;
  readonly width?: "short" | "medium" | "long";
  readonly numeric?: boolean;
  readonly placeholder?: string;
  readonly onChange: (value: string) => void;
}) => {
  const id = fieldId(field);

  return (
    <div className={styles["field"]}>
      <label className={kit["fieldLabel"]} htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className={`${kit["input"]} ${styles[width]}`}
        inputMode={numeric ? "numeric" : undefined}
        spellCheck={false}
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        aria-invalid={error !== undefined}
        aria-describedby={describedBy(id, hint, error)}
        onChange={(event) => onChange(event.target.value)}
      />
      <Notes id={id} hint={hint} error={error} />
    </div>
  );
};

const COOLING: ReadonlyArray<readonly [Cooling, string]> = [
  ["routing", "Follow the routing setting"],
  ["cool", "Rest the account"],
  ["never", "Never rest it"],
];

const CoolingField = ({
  value,
  onChange,
}: {
  readonly value: Cooling;
  readonly onChange: (value: Cooling) => void;
}) => {
  const id = fieldId("disable_cooling");

  return (
    <fieldset className={styles["choices"]} aria-describedby={`${id}-hint`}>
      <legend className={kit["fieldLabel"]}>After the provider turns requests away</legend>
      <div className={styles["choiceRow"]}>
        {COOLING.map(([choice, label], index) => (
          <label key={choice} className={styles["choice"]}>
            <input
              id={index === 0 ? id : undefined}
              type="radio"
              name={id}
              value={choice}
              checked={value === choice}
              onChange={() => onChange(choice)}
            />
            {label}
          </label>
        ))}
      </div>
      <span id={`${id}-hint`} className={styles["hint"]}>
        Resting skips the account until the provider's limit resets, so other accounts take its
        requests.
      </span>
    </fieldset>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// Aliases and headers: one row each; an error about a row is shown under that row

const RowError = ({ id, error }: { readonly id: string; readonly error: string }) => (
  <span id={id} className={`${kit["fieldError"]} ${styles["rowError"]}`}>
    {error}
  </span>
);

/** The group's error when it is not about one row. */
const GroupError = ({
  id,
  error,
}: {
  readonly id: string;
  readonly error: FieldError | undefined;
}) =>
  error === undefined || error.row !== undefined ? null : (
    <span id={`${id}-error`} className={kit["fieldError"]}>
      {error.message}
    </span>
  );

const ChannelRulesLink = ({
  provider,
  children,
}: {
  readonly provider: string;
  readonly children: ReactNode;
}) => (
  <Link to="/models/rules" hash={`channel-${provider}`}>
    {children}
  </Link>
);

const AliasRows = ({
  provider,
  rows,
  error,
  onChange,
}: {
  readonly provider: string;
  readonly rows: ReadonlyArray<AliasRow>;
  readonly error: FieldError | undefined;
  readonly onChange: (rows: ReadonlyArray<AliasRow>) => void;
}) => {
  const id = fieldId("model_aliases");

  const update = (row: AliasRow, change: Partial<AliasRow>) =>
    onChange(rows.map((known) => (known.id === row.id ? { ...known, ...change } : known)));

  const add = () => {
    const row: AliasRow = { id: rowId(), name: "", alias: "", fork: false, kept: {} };

    onChange([...rows, row]);
    requestAnimationFrame(() => document.getElementById(`${row.id}-name`)?.focus());
  };

  return (
    <fieldset
      id={id}
      className={styles["group"]}
      aria-invalid={error !== undefined}
      aria-describedby={describedBy(id, "hint", error?.row === undefined ? error : undefined)}
    >
      <legend className={kit["fieldLabel"]}>Model aliases</legend>
      <span id={`${id}-hint`} className={styles["hint"]}>
        Clients call the alias; the provider receives its own name; with Keep original, clients can
        use both. Applied before{" "}
        <ChannelRulesLink provider={provider}>the channel's aliases</ChannelRulesLink>. Empty: only
        the channel's aliases apply.
      </span>
      {rows.length === 0 ? null : (
        <div className={`${styles["aliasRow"]} ${styles["heads"]}`} aria-hidden="true">
          <span>Provider's name</span>
          <span>Alias for clients</span>
          <span>Keep original</span>
        </div>
      )}
      {rows.length === 0 ? null : (
        <div className={styles["rows"]} role="list">
          {rows.map((row, index) => {
            const rowError = error?.row === row.id ? error.message : undefined;
            const errorId = `${row.id}-error`;
            const described = rowError === undefined ? undefined : errorId;

            return (
              <div
                key={row.id}
                className={`${styles["aliasRow"]} ${rowError === undefined ? "" : styles["invalid"]}`}
                role="listitem"
                data-row={row.id}
              >
                <span className={styles["cell"]} data-label="Provider's name">
                  <input
                    id={`${row.id}-name`}
                    className={kit["input"]}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="e.g. claude-opus-4-5"
                    aria-label={`Provider's name, alias ${index + 1}`}
                    aria-invalid={rowError !== undefined}
                    aria-describedby={described}
                    value={row.name}
                    onChange={(event) => update(row, { name: event.target.value })}
                  />
                </span>
                <span className={styles["cell"]} data-label="Alias for clients">
                  <input
                    className={kit["input"]}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="e.g. opus"
                    aria-label={`Alias for clients, alias ${index + 1}`}
                    aria-invalid={rowError !== undefined}
                    aria-describedby={described}
                    value={row.alias}
                    onChange={(event) => update(row, { alias: event.target.value })}
                  />
                </span>
                <span className={`${styles["cell"]} ${styles["keep"]}`} data-label="Keep original">
                  <label className={styles["inlineCheck"]}>
                    <input
                      type="checkbox"
                      checked={row.fork}
                      onChange={(event) => update(row, { fork: event.target.checked })}
                    />
                    <span className={kit["visuallyHidden"]}>Keep original, alias {index + 1}</span>
                  </label>
                </span>
                <button
                  type="button"
                  className={styles["remove"]}
                  aria-label={`Remove the alias ${row.alias.trim() || index + 1}`}
                  onClick={() => onChange(rows.filter((known) => known.id !== row.id))}
                >
                  <X aria-hidden="true" size={16} strokeWidth={2.25} />
                </button>
                {rowError === undefined ? null : <RowError id={errorId} error={rowError} />}
              </div>
            );
          })}
        </div>
      )}
      <GroupError id={id} error={error} />
      <button type="button" className={styles["add"]} onClick={add}>
        <Plus aria-hidden="true" size={16} strokeWidth={2.25} />
        Add alias
      </button>
    </fieldset>
  );
};

const HeaderRows = ({
  rows,
  error,
  onChange,
}: {
  readonly rows: ReadonlyArray<HeaderRow>;
  readonly error: FieldError | undefined;
  readonly onChange: (rows: ReadonlyArray<HeaderRow>) => void;
}) => {
  const id = fieldId("headers");
  const hidden = rows.some((row) => row.hidden !== undefined);

  const hint = hidden
    ? "Sent with every request to the provider. Hidden values stay as they are unless you replace them. Empty: only what Commissary sends."
    : "Sent with every request to the provider, on top of what Commissary sends. Empty: only what Commissary sends.";

  const update = (row: HeaderRow, change: Partial<HeaderRow>) =>
    onChange(rows.map((known) => (known.id === row.id ? { ...known, ...change } : known)));

  const add = () => {
    const row: HeaderRow = { id: rowId(), name: "", value: "", hidden: undefined, added: true };

    onChange([...rows, row]);
    requestAnimationFrame(() => document.getElementById(`${row.id}-name`)?.focus());
  };

  return (
    <fieldset
      id={id}
      className={styles["group"]}
      aria-invalid={error !== undefined}
      aria-describedby={describedBy(id, hint, error?.row === undefined ? error : undefined)}
    >
      <legend className={kit["fieldLabel"]}>Extra request headers</legend>
      <span id={`${id}-hint`} className={styles["hint"]}>
        {hint}
      </span>
      {rows.length === 0 ? null : (
        <div className={styles["rows"]} role="list">
          {rows.map((row, index) => {
            const label = row.name.trim() || `header ${index + 1}`;
            const rowError = error?.row === row.id ? error.message : undefined;
            const errorId = `${row.id}-error`;
            const described = rowError === undefined ? undefined : errorId;
            const tail = row.hidden === undefined ? undefined : maskTail(row.hidden.mask);

            return (
              <div
                key={row.id}
                className={`${styles["headerRow"]} ${rowError === undefined ? "" : styles["invalid"]}`}
                role="listitem"
                data-row={row.id}
              >
                {row.hidden === undefined ? (
                  <input
                    id={`${row.id}-name`}
                    className={kit["input"]}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="Name, e.g. X-Team"
                    aria-label={`Name of ${label}`}
                    aria-invalid={rowError !== undefined}
                    aria-describedby={described}
                    value={row.name}
                    onChange={(event) => update(row, { name: event.target.value })}
                  />
                ) : (
                  <span id={`${row.id}-name`} className={styles["headerName"]}>
                    {row.name}
                  </span>
                )}
                {row.hidden === undefined ? (
                  <input
                    id={`${row.id}-value`}
                    className={kit["input"]}
                    type={isSecretRow(row) ? "password" : "text"}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={row.replaced === true ? "New value" : "Value"}
                    aria-label={`Value of ${label}`}
                    aria-invalid={rowError !== undefined}
                    aria-describedby={described}
                    value={row.value}
                    onChange={(event) => update(row, { value: event.target.value })}
                  />
                ) : (
                  <span className={styles["hidden"]}>
                    <span className={styles["hiddenText"]}>
                      Hidden{tail === undefined ? "" : `, ends ${tail}`}
                    </span>
                    <button
                      type="button"
                      className={kit["secondary"]}
                      aria-label={`Replace the value of ${row.name}`}
                      onClick={() => {
                        update(row, { value: "", hidden: undefined, replaced: true });
                        requestAnimationFrame(() =>
                          document.getElementById(`${row.id}-value`)?.focus(),
                        );
                      }}
                    >
                      Replace value
                    </button>
                  </span>
                )}
                <button
                  type="button"
                  className={styles["remove"]}
                  aria-label={`Remove ${label}`}
                  onClick={() => onChange(rows.filter((known) => known.id !== row.id))}
                >
                  <X aria-hidden="true" size={16} strokeWidth={2.25} />
                </button>
                {rowError === undefined ? null : <RowError id={errorId} error={rowError} />}
              </div>
            );
          })}
        </div>
      )}
      <GroupError id={id} error={error} />
      <button type="button" className={styles["add"]} onClick={add}>
        <Plus aria-hidden="true" size={16} strokeWidth={2.25} />
        Add header
      </button>
    </fieldset>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// Leaving with unsaved changes

const LeaveGuard = ({ count }: { readonly count: number }) => {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  const blocker = useBlocker({
    // A jump within the page is not leaving it.
    shouldBlockFn: ({ current, next }) => current.pathname !== next.pathname,
    enableBeforeUnload: count > 0,
    disabled: count === 0,
    withResolver: true,
  });

  useEffect(() => {
    if (blocker.status === "blocked") dialog.current?.showModal();
    else dialog.current?.close();
  }, [blocker.status]);

  return (
    <dialog
      ref={dialog}
      className={kit["dialog"]}
      aria-labelledby={titleId}
      onCancel={() => blocker.reset?.()}
    >
      <div className={kit["dialogBody"]}>
        <h2 id={titleId} className={kit["dialogTitle"]}>
          Leave without saving?
        </h2>
        <p>
          {count === 1 ? "A change" : `${count} changes`} to this account's routing{" "}
          {count === 1 ? "is" : "are"} not saved and will be lost.
        </p>
        <div className={kit["dialogActions"]}>
          <button type="button" className={kit["danger"]} onClick={() => blocker.proceed?.()}>
            Leave
          </button>
          <button type="button" className={kit["secondary"]} onClick={() => blocker.reset?.()}>
            Stay
          </button>
        </div>
      </div>
    </dialog>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// The section

const prefixHint = (prefix: string): ReactNode => {
  const shown = prefixOf(prefix);

  return (
    <>
      {shown === "" || shown.includes("/") || /\s/.test(shown)
        ? "Clients add it before a model name to reach this account alone. Empty: no prefix."
        : `Clients call ${shown}/ plus a model name to reach this account alone.`}{" "}
      Plain names keep reaching it unless{" "}
      <Link to="/settings" hash="routing">
        Settings
      </Link>{" "}
      say otherwise. <Link to="/models">Models</Link> lists the names clients can call.
    </>
  );
};

export const Routing = ({ entry }: { readonly entry: CredentialEntry }) => {
  const save = useAction(patchFieldsAtom);
  const [edits, setEdits] = useState<Edits>({});
  const [base, setBase] = useState(entry);
  const [tried, setTried] = useState(false);
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});
  const [problem, setProblem] = useState<string | undefined>(undefined);
  /** A save landed; waiting for the refreshed account. */
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);

  // A refreshed account: keep the edits it does not already show (derived state, set while rendering).
  if (base !== entry) {
    setEdits(rebaseEdits(entry, edits));
    setBase(entry);

    if (pending) {
      setPending(false);
      setSaved(true);
    }
  }

  useEffect(() => {
    if (!saved) return undefined;
    const timer = setTimeout(() => setSaved(false), SAVED_FOR_MS);

    return () => clearTimeout(timer);
  }, [saved]);

  const draft = shownDraft(entry, edits);
  const count = changedFields(entry, edits).length;

  // Draft problems show once a save was tried; the server's stay until their field changes.
  const errors: FieldErrors = tried
    ? { ...draftErrors(entry, edits), ...serverErrors }
    : serverErrors;

  const busy = save.busy || pending;
  const applies = (key: FieldKey) => appliesTo(entry.provider, key);

  const set = <Key extends keyof Draft>(key: Key, value: Draft[Key]) => {
    setEdits({ ...edits, [key]: value });
    setSaved(false);
    setProblem(undefined);

    if (serverErrors[key] !== undefined) {
      const { [key]: _gone, ...rest } = serverErrors;

      setServerErrors(rest);
    }
  };

  const discard = () => {
    setEdits({});
    setTried(false);
    setServerErrors({});
    setProblem(undefined);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTried(true);
    setProblem(undefined);
    setServerErrors({});
    const found = draftErrors(entry, edits);
    const first = FIELD_ORDER.find((key) => found[key] !== undefined);

    if (first !== undefined) {
      focusField(first, found[first]?.row);

      return;
    }

    if (count === 0) return;

    const outcome = await save.run({
      payload: { name: entry.name, ...patchOf(entry, edits) },
      reactivityKeys: CREDENTIALS,
    });

    if (outcome.ok) {
      setTried(false);
      setPending(true);

      return;
    }

    const reason = outcome.error ?? outcome.message;
    const refused = serverError(draft, outcome.path, sentence(reason));

    if (refused !== undefined) {
      setServerErrors({ [refused.key]: refused.error });
      focusField(refused.key, refused.error.row);

      return;
    }

    setProblem(outcome.message);
  };

  const state = count > 0 ? changesText(count) : saved ? "Saved. Applies to the next request." : "";

  return (
    <section id="routing" className={styles["section"]} aria-labelledby="routing-title">
      <form noValidate onSubmit={submit} aria-labelledby="routing-title">
        <header className={kit["sectionHead"]}>
          <h2 id="routing-title" className={kit["sectionTitle"]} tabIndex={-1}>
            Routing
          </h2>
          <span className={styles["state"]} role="status">
            {state}
          </span>
        </header>
        <p className={styles["lead"]}>
          How Commissary picks this account and what it sends to {providerName(entry.provider)}.
          Empty fields use the default shown under them.
        </p>

        <div className={styles["groups"]}>
          <div className={styles["group"]}>
            <h3 className={styles["groupTitle"]}>Picking this account</h3>
            <div className={styles["grid"]}>
              <TextField
                field="priority"
                label="Priority"
                hint="Highest first. Empty means 0."
                numeric
                value={draft.priority}
                error={errors.priority?.message}
                onChange={(value) => set("priority", value)}
              />
              <TextField
                field="weight"
                label="Weight"
                hint="Its share under the weighted strategy; 0 takes none. Empty means 1."
                numeric
                value={draft.weight}
                error={errors.weight?.message}
                onChange={(value) => set("weight", value)}
              />
              <TextField
                field="request_retry"
                label="Retry rounds"
                hint={
                  <>
                    Extra rounds after a failure. Empty uses the{" "}
                    <Link to="/settings" hash="routing">
                      routing setting
                    </Link>
                    .
                  </>
                }
                numeric
                value={draft.request_retry}
                error={errors.request_retry?.message}
                onChange={(value) => set("request_retry", value)}
              />
            </div>
            <CoolingField
              value={draft.disable_cooling}
              onChange={(value) => set("disable_cooling", value)}
            />
            {applies("websockets") ? (
              <div className={styles["field"]}>
                <label className={styles["check"]}>
                  <input
                    id={fieldId("websockets")}
                    type="checkbox"
                    checked={draft.websockets}
                    aria-describedby={`${fieldId("websockets")}-hint`}
                    onChange={(event) => set("websockets", event.target.checked)}
                  />
                  Prefer this account for WebSocket requests
                </label>
                <span id={`${fieldId("websockets")}-hint`} className={styles["hint"]}>
                  Responses requests that arrive over a WebSocket go to accounts with this on first.
                </span>
              </div>
            ) : null}
          </div>

          <div className={styles["group"]}>
            <h3 className={styles["groupTitle"]}>Model names</h3>
            <TextField
              field="prefix"
              label="Model prefix"
              hint={prefixHint(draft.prefix)}
              width="medium"
              placeholder="e.g. team"
              value={draft.prefix}
              error={errors.prefix?.message}
              onChange={(value) => set("prefix", value)}
            />
            <div className={styles["field"]}>
              <label className={kit["fieldLabel"]} htmlFor={fieldId("excluded_models")}>
                Models this account does not serve
              </label>
              <textarea
                id={fieldId("excluded_models")}
                className={`${kit["input"]} ${styles["lines"]}`}
                rows={Math.min(8, Math.max(3, draft.excluded_models.split("\n").length + 1))}
                spellCheck={false}
                autoComplete="off"
                placeholder={"claude-3-*\ngpt-4o"}
                value={draft.excluded_models}
                aria-invalid={errors.excluded_models !== undefined}
                aria-describedby={describedBy(
                  fieldId("excluded_models"),
                  "hint",
                  errors.excluded_models,
                )}
                onChange={(event) => set("excluded_models", event.target.value)}
              />
              <Notes
                id={fieldId("excluded_models")}
                hint={
                  <>
                    One name per line; * matches any run of characters. Adds to{" "}
                    <ChannelRulesLink provider={entry.provider}>
                      the channel's exclusions
                    </ChannelRulesLink>
                    . Empty: only the channel's exclusions apply.
                  </>
                }
                error={errors.excluded_models?.message}
              />
            </div>
            {applies("model_aliases") ? (
              <AliasRows
                provider={entry.provider}
                rows={draft.model_aliases}
                error={errors.model_aliases}
                onChange={(rows) => set("model_aliases", rows)}
              />
            ) : (
              <p className={styles["hint"]}>
                {providerName(entry.provider)} accounts take their aliases from{" "}
                <ChannelRulesLink provider={entry.provider}>the channel's rules</ChannelRulesLink>.
              </p>
            )}
          </div>

          <div className={styles["group"]}>
            <h3 className={styles["groupTitle"]}>Requests</h3>
            <HeaderRows
              rows={draft.headers}
              error={errors.headers}
              onChange={(rows) => set("headers", rows)}
            />
            <TextField
              field="note"
              label="Note"
              hint="Shown under the account's name; Commissary does not read it. Empty: no note."
              width="long"
              value={draft.note}
              error={errors.note?.message}
              onChange={(value) => set("note", value)}
            />
          </div>
        </div>

        {count === 0 && problem === undefined ? null : (
          <div className={styles["actions"]}>
            {problem === undefined ? null : <Problem>Could not save. {problem}</Problem>}
            {count === 0 ? null : (
              <div className={styles["buttons"]}>
                <button type="submit" className={kit["primary"]} disabled={busy}>
                  {busy ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  className={kit["secondary"]}
                  disabled={busy}
                  onClick={discard}
                >
                  Discard
                </button>
              </div>
            )}
          </div>
        )}
      </form>
      <LeaveGuard count={count} />
    </section>
  );
};
