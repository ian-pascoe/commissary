// People (/people): a platform admin of Commissary Cloud looks a person up by email, sets how many orgs they may own and
// suspends or unsuspends them (ADR 0026). Not scoped to an org, so it opens without the shell, like the org chooser.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { type FormEvent, useId, useState } from "react";
import type { PersonView } from "#contract/people.ts";
import { getPersonAtom, meAtom, updatePersonAtom } from "../api/client.ts";
import { ConfirmDialog, type ConfirmRequest } from "../components/Confirm.tsx";
import { kit, Problem } from "../components/Kit.tsx";
import { SignOut } from "../components/SignOut.tsx";
import {
  canSuspend,
  emailProblem,
  ORG_LIMIT_MAX,
  parseOrgLimit,
  personProblem,
} from "../lib/hosted.ts";
import { formatDate } from "../lib/format.ts";
import { useAction } from "../lib/use-action.ts";
import { usePageTitle } from "../lib/use-page-title.ts";
import styles from "./People.module.css";

const signedUp = (person: PersonView): string => {
  const at = person.signed_up_at === undefined ? Number.NaN : Date.parse(person.signed_up_at);

  return Number.isNaN(at) ? "Has not signed in yet" : formatDate(at);
};

const Person = ({
  person,
  onChange,
}: {
  readonly person: PersonView;
  readonly onChange: (person: PersonView) => void;
}) => {
  const update = useAction(updatePersonAtom);
  const ids = useId();
  const [limit, setLimit] = useState(person.org_limit_set ? String(person.org_limit) : "default");
  const [note, setNote] = useState<string | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [confirm, setConfirm] = useState<ConfirmRequest | undefined>(undefined);
  const parsed = parseOrgLimit(limit);

  const saveLimit = async (event: FormEvent) => {
    event.preventDefault();
    setNote(undefined);
    setProblem(undefined);

    if (parsed.kind === "invalid") return;

    const outcome = await update.run({
      params: { email: person.email },
      payload: { org_limit: parsed.kind === "default" ? null : parsed.value },
    });

    if (outcome.ok) {
      onChange(outcome.value);
      setNote("Saved the org limit.");
    } else setProblem(personProblem(outcome.error, outcome.message, outcome.detail));
  };

  const askSuspension = () => {
    const suspend = !person.suspended;

    setNote(undefined);
    setProblem(undefined);

    setConfirm({
      title: `${suspend ? "Suspend" : "Unsuspend"} ${person.email}?`,
      body: suspend ? (
        <p>
          They are signed out and their sessions, API keys and management keys are refused until you
          unsuspend them. Nothing is deleted: their orgs and keys stay as they are.
        </p>
      ) : (
        <p>They can sign in again, and their API keys and management keys work again.</p>
      ),
      action: suspend ? "Suspend person" : "Unsuspend person",
      busyAction: suspend ? "Suspending…" : "Unsuspending…",
      run: async () => {
        const outcome = await update.run({
          params: { email: person.email },
          payload: { suspended: suspend },
        });

        if (outcome.ok) {
          onChange(outcome.value);
          setNote(suspend ? "Suspended." : "Unsuspended.");
        } else setProblem(personProblem(outcome.error, outcome.message, outcome.detail));
      },
    });
  };

  return (
    <section className={styles["person"]} aria-label={person.email}>
      <h2 className={kit["sectionTitle"]}>
        {person.email}
        {person.suspended ? <span className={styles["state"]}>Suspended</span> : null}
      </h2>
      <dl className={styles["facts"]}>
        <div>
          <dt>Signed up</dt>
          <dd>{signedUp(person)}</dd>
        </div>
        <div>
          <dt>Orgs owned</dt>
          <dd>
            {person.owned_orgs} of {person.org_limit}
          </dd>
        </div>
        <div>
          <dt>Limit</dt>
          <dd>{person.org_limit_set ? "Set by a platform admin" : "The deployment’s default"}</dd>
        </div>
      </dl>
      <form className={styles["limit"]} onSubmit={saveLimit} aria-label="Org limit">
        <div className={kit["field"]}>
          <label className={kit["fieldLabel"]} htmlFor={`${ids}-limit`}>
            Org limit
          </label>
          <input
            id={`${ids}-limit`}
            className={kit["input"]}
            value={limit}
            inputMode="numeric"
            autoComplete="off"
            aria-invalid={parsed.kind === "invalid"}
            aria-describedby={`${ids}-hint`}
            onChange={(event) => setLimit(event.target.value)}
          />
        </div>
        <button
          type="submit"
          className={kit["secondary"]}
          disabled={update.busy || parsed.kind === "invalid"}
        >
          Save limit
        </button>
        <p
          id={`${ids}-hint`}
          className={parsed.kind === "invalid" ? kit["fieldError"] : kit["muted"]}
        >
          A whole number from 0 to {ORG_LIMIT_MAX}, or “default” for the deployment&rsquo;s default.
        </p>
      </form>
      <div>
        <button
          type="button"
          className={person.suspended ? kit["secondary"] : kit["danger"]}
          disabled={update.busy}
          onClick={askSuspension}
        >
          {person.suspended ? "Unsuspend" : "Suspend"}
        </button>
      </div>
      {problem === undefined ? null : <Problem>{problem}</Problem>}
      <p className={kit["muted"]} role="status">
        {note}
      </p>
      <ConfirmDialog request={confirm} busy={update.busy} onClose={() => setConfirm(undefined)} />
    </section>
  );
};

const Lookup = () => {
  const lookup = useAction(getPersonAtom);
  const ids = useId();
  const [email, setEmail] = useState("");
  const [tried, setTried] = useState(false);
  const [person, setPerson] = useState<PersonView | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const emailIssue = tried ? emailProblem(email) : undefined;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    setProblem(undefined);

    if (emailProblem(email) !== undefined) return;

    const outcome = await lookup.run({ params: { email: email.trim() } });

    if (outcome.ok) setPerson(outcome.value);
    else {
      setPerson(undefined);
      setProblem(personProblem(outcome.error, outcome.message, outcome.detail));
    }
  };

  return (
    <>
      <form className={styles["lookup"]} onSubmit={submit} noValidate aria-label="Find a person">
        <div className={kit["field"]}>
          <label className={kit["fieldLabel"]} htmlFor={`${ids}-email`}>
            Email
          </label>
          <input
            id={`${ids}-email`}
            className={kit["input"]}
            type="email"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={email}
            aria-invalid={emailIssue !== undefined}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <button type="submit" className={kit["primary"]} disabled={lookup.busy}>
          {lookup.busy ? "Looking…" : "Look up"}
        </button>
      </form>
      {emailIssue === undefined ? null : <p className={kit["fieldError"]}>{emailIssue}</p>}
      {problem === undefined ? null : <Problem>{problem}</Problem>}
      {person === undefined ? null : (
        <Person key={person.email} person={person} onChange={setPerson} />
      )}
    </>
  );
};

export const PeoplePage = () => {
  usePageTitle("People");
  const result = useAtomValue(meAtom);
  const retry = useAtomRefresh(meAtom);

  return (
    <main id="main" className={styles["page"]}>
      <h1 className={styles["title"]}>People</h1>
      {AsyncResult.match(result, {
        onInitial: () => (
          <p className={kit["muted"]} aria-busy="true">
            Loading…
          </p>
        ),
        onFailure: () => <Problem onRetry={retry}>Could not check your access.</Problem>,
        onSuccess: ({ value }) =>
          canSuspend(value) ? (
            <>
              <p className={kit["muted"]}>
                Look a person up to change how many orgs they may own, or to suspend them. Someone
                who has not signed in yet can be looked up too.
              </p>
              <Lookup />
              <p>
                <a className={styles["link"]} href="/?choose">
                  Back to the orgs
                </a>
              </p>
              <SignOut className={kit["secondary"]} />
            </>
          ) : (
            <p className={kit["muted"]}>Only platform admins of Commissary Cloud manage people.</p>
          ),
      })}
    </main>
  );
};
