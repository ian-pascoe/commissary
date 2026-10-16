// The org's usage retention period (ADR 0027): how long usage records are kept before the scheduled prune deletes them.
// Org admins set it, from 1 to 3650 days or "keep forever"; where none is set (an org that predates the setting) the
// section suggests 90 days, the default of a new org.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { type FormEvent, useId, useState } from "react";
import type { OrgView } from "@commissary/contract/orgs";
import { orgAtom, ORGS, updateOrgSettingsAtom } from "../api/client.ts";
import { kit, Problem } from "../components/Kit.tsx";
import { failureMessage } from "../lib/failure.ts";
import {
  MAX_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  parseRetentionDays,
  retentionSentence,
  SUGGESTED_RETENTION_DAYS,
} from "../lib/retention.ts";
import { useAction } from "../lib/use-action.ts";
import styles from "./SettingsOrg.module.css";
import settings from "./Settings.module.css";

type Mode = "days" | "forever";

/** The choice and the days input; remounted (`key`) when the saved period changes, so it starts from the new one. */
const RetentionForm = ({
  days,
  onSave,
  busy,
}: {
  readonly days: number | null;
  readonly onSave: (days: number | null) => void;
  readonly busy: boolean;
}) => {
  const [mode, setMode] = useState<Mode>(days === null ? "forever" : "days");
  const [text, setText] = useState(String(days ?? SUGGESTED_RETENTION_DAYS));
  const ids = useId();
  const parsed = mode === "forever" ? null : parseRetentionDays(text);
  const invalid = mode === "days" && parsed === undefined;
  const unchanged = parsed === days;

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (parsed !== undefined && !unchanged) onSave(parsed);
  };

  return (
    <form className={styles["form"]} onSubmit={submit} aria-label="Usage retention">
      <fieldset className={styles["choices"]}>
        <legend className={kit["visuallyHidden"]}>How long usage records are kept</legend>
        <label className={styles["choice"]} htmlFor={`${ids}-days`}>
          <input
            id={`${ids}-days`}
            type="radio"
            name={`${ids}-mode`}
            checked={mode === "days"}
            onChange={() => setMode("days")}
          />
          <span>Keep for</span>
          <input
            className={`${kit["input"]} ${styles["days"]}`}
            type="number"
            inputMode="numeric"
            min={MIN_RETENTION_DAYS}
            max={MAX_RETENTION_DAYS}
            step={1}
            value={text}
            aria-label="Days"
            aria-invalid={invalid}
            onFocus={() => setMode("days")}
            onChange={(event) => {
              setMode("days");
              setText(event.target.value);
            }}
          />
          <span>days</span>
        </label>
        <label className={styles["choice"]}>
          <input
            type="radio"
            name={`${ids}-mode`}
            checked={mode === "forever"}
            onChange={() => setMode("forever")}
          />
          <span>Keep forever</span>
        </label>
      </fieldset>
      {invalid ? (
        <p className={kit["fieldError"]}>
          Whole days, from {MIN_RETENTION_DAYS} to {MAX_RETENTION_DAYS}.
        </p>
      ) : null}
      <div className={styles["actions"]}>
        <button
          type="submit"
          className={kit["primary"]}
          disabled={busy || invalid || unchanged}
          aria-busy={busy}
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
};

const Retention = ({ org }: { readonly org: OrgView }) => {
  const update = useAction(updateOrgSettingsAtom);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [saved, setSaved] = useState(false);
  const days = org.usage_retention_days;

  const save = async (next: number | null) => {
    setProblem(undefined);
    setSaved(false);

    const outcome = await update.run({
      payload: { usage_retention_days: next },
      reactivityKeys: ORGS,
    });

    if (outcome.ok) setSaved(true);
    else setProblem(outcome.detail ?? outcome.message);
  };

  return (
    <>
      <p className={settings["lead"]}>
        <b>{retentionSentence(days)}</b> Older records are deleted automatically. A usage record
        holds tokens, cost, latency and the outcome of a request, never its prompt or response.
      </p>
      {days === null ? (
        <div className={styles["suggest"]}>
          <p>
            No retention period is set: usage records are kept until you delete the org.{" "}
            {SUGGESTED_RETENTION_DAYS} days is a common choice.
          </p>
          <button
            type="button"
            className={kit["secondary"]}
            disabled={update.busy}
            onClick={() => save(SUGGESTED_RETENTION_DAYS)}
          >
            Use {SUGGESTED_RETENTION_DAYS} days
          </button>
        </div>
      ) : null}
      <RetentionForm key={String(days)} days={days} busy={update.busy} onSave={save} />
      {problem === undefined ? null : (
        <p className={kit["fieldError"]} role="alert">
          {problem}
        </p>
      )}
      {saved && problem === undefined ? (
        <p className={styles["state"]} role="status">
          Saved.
        </p>
      ) : null}
    </>
  );
};

/** The section's body: the org's current period, once read. Only org admins reach the page, and they may change it. */
export const RetentionBody = () => {
  const result = useAtomValue(orgAtom);
  const retry = useAtomRefresh(orgAtom);

  return AsyncResult.match(result, {
    onInitial: () => (
      <p className={kit["muted"]} aria-busy="true">
        Loading the retention period…
      </p>
    ),
    onFailure: (failure) => (
      <Problem onRetry={retry}>
        Could not load the retention period. {failureMessage(failure)}
      </Problem>
    ),
    onSuccess: ({ value }) => <Retention org={value} />,
  });
};
