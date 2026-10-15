// Management keys (/management-keys): keys for scripts that call the management API (`Authorization: Bearer cmsm_…`)
// instead of a browser session (ADR 0026). Org admins issue, list and revoke them; a key holds a role no higher than
// its issuer's. Like an API key it is shown whole once, in the answer to its creation.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { KeyRound } from "lucide-react";
import { AsyncResult } from "effect/reactivity";
import { type FormEvent, useId, useState } from "react";
import type { CreatedManagementKey, ManagementKeyView } from "#contract/management-keys.ts";
import {
  createManagementKeyAtom,
  MANAGEMENT_KEYS,
  managementKeysAtom,
  revokeManagementKeyAtom,
} from "../api/client.ts";
import { ConfirmDialog, type ConfirmRequest } from "../components/Confirm.tsx";
import { kit, Problem, Section } from "../components/Kit.tsx";
import { failureMessage } from "../lib/failure.ts";
import {
  issuableRoles,
  issuerText,
  keyCreatedText,
  keyLastUsedText,
  managementKeyProblem,
  sortManagementKeys,
} from "../lib/management-keys.ts";
import { keyNameProblem } from "../lib/api-keys.ts";
import { type Caller, roleLabel, roleOf, roleSummary } from "../lib/role.ts";
import { useAction } from "../lib/use-action.ts";
import { usePageTitle } from "../lib/use-page-title.ts";
import { useRole } from "../lib/use-role.ts";
import { Reveal } from "./ApiKeys.tsx";
import styles from "./ApiKeys.module.css";

type Note = { readonly tone: "done" | "problem"; readonly text: string };

const NoteLine = ({ note, what }: { readonly note: Note | undefined; readonly what: string }) => (
  <>
    {note?.tone === "problem" ? (
      <Problem>
        Could not {what}. {note.text}
      </Problem>
    ) : null}
    <p className={styles["note"]} role="status">
      {note?.tone === "done" ? note.text : null}
    </p>
  </>
);

const NewKey = ({
  caller,
  onCreated,
}: {
  readonly caller: Caller;
  readonly onCreated: (created: CreatedManagementKey) => void;
}) => {
  const ids = useId();
  const create = useAction(createManagementKeyAtom);
  const roles = issuableRoles(caller);
  const [name, setName] = useState("");
  const [role, setRole] = useState(roles[0] ?? "member");
  const [tried, setTried] = useState(false);
  const [note, setNote] = useState<Note | undefined>(undefined);
  const nameIssue = tried ? keyNameProblem(name) : undefined;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTried(true);
    setNote(undefined);

    if (keyNameProblem(name) !== undefined) return;

    const outcome = await create.run({
      payload: { name: name.trim(), role },
      reactivityKeys: MANAGEMENT_KEYS,
    });

    if (outcome.ok) {
      setName("");
      setTried(false);
      onCreated(outcome.value);
    } else {
      setNote({
        tone: "problem",
        text: managementKeyProblem(outcome.error, outcome.message, outcome.detail),
      });
    }
  };

  return (
    <>
      <form
        className={styles["form"]}
        onSubmit={submit}
        noValidate
        aria-label="Create a management key"
      >
        <div className={styles["formRow"]}>
          <div className={kit["field"]}>
            <label className={kit["fieldLabel"]} htmlFor={`${ids}-name`}>
              Name
            </label>
            <input
              id={`${ids}-name`}
              className={kit["input"]}
              autoComplete="off"
              placeholder="ci, deploy script"
              value={name}
              aria-invalid={nameIssue !== undefined}
              aria-describedby={`${ids}-hint`}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className={`${kit["field"]} ${styles["expiry"]}`}>
            <label className={kit["fieldLabel"]} htmlFor={`${ids}-role`}>
              Role
            </label>
            <select
              id={`${ids}-role`}
              className={kit["input"]}
              value={role}
              aria-describedby={`${ids}-hint`}
              onChange={(event) => setRole(roleOf(event.target.value) ?? role)}
            >
              {roles.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {roleLabel(candidate)}
                </option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            className={kit["primary"]}
            disabled={create.busy}
            aria-busy={create.busy}
          >
            <KeyRound aria-hidden="true" size={18} strokeWidth={2.25} />
            {create.busy ? "Creating…" : "Create key"}
          </button>
        </div>
        <p
          id={`${ids}-hint`}
          className={nameIssue === undefined ? kit["muted"] : kit["fieldError"]}
        >
          {nameIssue ?? `${roleSummary(role)} You can give a key your role or a lower one.`}
        </p>
      </form>
      <NoteLine note={note} what="create the key" />
    </>
  );
};

const Keys = () => {
  const result = useAtomValue(managementKeysAtom);
  const retry = useAtomRefresh(managementKeysAtom);
  const revoke = useAction(revokeManagementKeyAtom);
  const [confirm, setConfirm] = useState<ConfirmRequest | undefined>(undefined);
  const [note, setNote] = useState<Note | undefined>(undefined);

  if (!AsyncResult.isSuccess(result)) {
    return AsyncResult.isFailure(result) ? (
      <Problem onRetry={retry}>Could not load the keys. {failureMessage(result)}</Problem>
    ) : (
      <p className={kit["muted"]} aria-busy="true">
        Loading the keys…
      </p>
    );
  }

  const now = Date.now();
  const keys = sortManagementKeys(result.value.keys);

  const askRevoke = (key: ManagementKeyView) => {
    setNote(undefined);

    setConfirm({
      title: `Revoke ${key.name}?`,
      body: (
        <p>
          Anything that sends {key.prefix}… is refused from its next request on (other servers
          within 30 seconds). This cannot be undone; create a new key to replace it.
        </p>
      ),
      action: "Revoke key",
      busyAction: "Revoking…",
      run: async () => {
        const outcome = await revoke.run({
          params: { id: key.id },
          reactivityKeys: MANAGEMENT_KEYS,
        });

        setNote(
          outcome.ok
            ? { tone: "done", text: `Revoked ${key.name}.` }
            : {
                tone: "problem",
                text: managementKeyProblem(outcome.error, outcome.message, outcome.detail),
              },
        );
      },
    });
  };

  return (
    <>
      {keys.length === 0 ? (
        <p className={styles["empty"]}>No management keys yet. Create one above for a script.</p>
      ) : (
        <div className={styles["scroll"]} role="region" aria-label="Management keys" tabIndex={0}>
          <table className={styles["table"]}>
            <thead>
              <tr>
                <th scope="col">Key</th>
                <th scope="col">Role</th>
                <th scope="col">Issued by</th>
                <th scope="col">Created</th>
                <th scope="col">Last used</th>
                <th scope="col">
                  <span className={kit["visuallyHidden"]}>Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.id}>
                  <th scope="row" className={styles["name"]}>
                    {key.name}
                    <span className={styles["secondary"]}>{key.prefix}…</span>
                  </th>
                  <td>{roleLabel(key.role)}</td>
                  <td className={styles["member"]}>{issuerText(key)}</td>
                  <td>{keyCreatedText(key)}</td>
                  <td>{keyLastUsedText(key, now)}</td>
                  <td className={styles["actions"]}>
                    <button
                      type="button"
                      className={styles["revoke"]}
                      aria-label={`Revoke ${key.name}`}
                      disabled={revoke.busy}
                      onClick={() => askRevoke(key)}
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <NoteLine note={note} what="revoke the key" />
      <ConfirmDialog request={confirm} busy={revoke.busy} onClose={() => setConfirm(undefined)} />
    </>
  );
};

export const ManagementKeysPage = () => {
  usePageTitle("Management keys");
  const role = useRole();
  const [created, setCreated] = useState<CreatedManagementKey | undefined>(undefined);

  if (role.kind !== "ready") return null;

  return (
    <div className={kit["page"]}>
      <header className={styles["head"]}>
        <h1 className={styles["title"]}>Management keys</h1>
        <p className={styles["intro"]}>
          A management key is for scripts that call this org&rsquo;s management API: send it as{" "}
          <code>Authorization: Bearer cmsm_…</code>. It holds the role you give it and works on the
          management API only, never on the client API.
        </p>
      </header>
      {created === undefined ? null : (
        <Reveal created={created} label="Management key" onDismiss={() => setCreated(undefined)} />
      )}
      <Section title="New key">
        <NewKey caller={role.caller} onCreated={setCreated} />
      </Section>
      <Section title="Keys in this org">
        <Keys />
      </Section>
    </div>
  );
};
