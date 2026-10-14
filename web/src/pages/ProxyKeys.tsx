// Proxy keys (/proxy-keys): the keys clients send on the proxy routes instead of an Access sign-in (ADR 0022). Every
// member creates, lists and revokes their own; org admins see and revoke every key of the org. A key is shown whole
// once, in the answer to its creation: the page keeps it in memory until it is dismissed and never asks for it again.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Check, Copy, KeyRound } from "lucide-react";
import { AsyncResult } from "effect/reactivity";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import type { CreatedProxyKey, ProxyKeyView } from "#contract/proxy-keys.ts";
import {
  createProxyKeyAtom,
  meAtom,
  PROXY_KEYS,
  proxyKeysAtom,
  revokeProxyKeyAtom,
} from "../api/client.ts";
import { ConfirmDialog, type ConfirmRequest } from "../components/Confirm.tsx";
import { kit, Problem, Section } from "../components/Kit.tsx";
import { failureMessage } from "../lib/failure.ts";
import { formatCount } from "../lib/format.ts";
import {
  canRevoke,
  createdText,
  expiresText,
  expiryIso,
  expiryProblem,
  filterKeys,
  KEY_FILTERS,
  KEY_HEADERS,
  type KeyFilter,
  keyNameProblem,
  keyProblem,
  keyStatus,
  lastUsedText,
  memberName,
  notMemberNote,
  revokedText,
  showMemberColumn,
  sortKeys,
  statusLabel,
  todayInput,
} from "../lib/proxy-keys.ts";
import { type Caller, roleAs, seesEveryProxyKey } from "../lib/role.ts";
import { useAction } from "../lib/use-action.ts";
import { usePageTitle } from "../lib/use-page-title.ts";
import { useRole } from "../lib/use-role.ts";
import styles from "./ProxyKeys.module.css";

/** What the last write said: a result to announce, or why it was refused. */
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

/** The new key, whole, with the warning that this is the only time it is shown. */
export const Reveal = ({
  created,
  onDismiss,
  label = "Proxy key",
}: {
  readonly created: { readonly id: string; readonly name: string; readonly key: string };
  readonly onDismiss: () => void;
  /** What the key is called for assistive technology. */
  readonly label?: string;
}) => {
  const headingId = useId();
  const field = useRef<HTMLInputElement>(null);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");

  // Put the key under the cursor, selected, so Ctrl+C works even where the clipboard button is refused.
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, [created.id]);

  return (
    <section className={styles["reveal"]} aria-labelledby={headingId}>
      <h2 id={headingId} className={styles["revealTitle"]}>
        Copy {created.name} now
      </h2>
      <p className={styles["revealWarning"]}>
        This is the only time the whole key is shown. You won&rsquo;t see it again once you dismiss
        this or leave the page. If you lose it, revoke it and create another.
      </p>
      <div className={styles["secret"]}>
        <label className={kit["visuallyHidden"]} htmlFor={`${headingId}-key`}>
          {label}
        </label>
        <input
          id={`${headingId}-key`}
          ref={field}
          className={`${kit["input"]} ${styles["secretValue"]}`}
          readOnly
          spellCheck={false}
          autoComplete="off"
          value={created.key}
          onFocus={(event) => event.currentTarget.select()}
        />
        <button
          type="button"
          className={kit["secondary"]}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(created.key);
              setCopy("copied");
            } catch {
              setCopy("failed");
            }
          }}
        >
          {copy === "copied" ? (
            <Check aria-hidden="true" size={16} strokeWidth={2.5} />
          ) : (
            <Copy aria-hidden="true" size={16} strokeWidth={2.25} />
          )}
          {copy === "copied" ? "Copied" : "Copy key"}
        </button>
      </div>
      <p className={styles["note"]} role="status">
        {copy === "failed"
          ? "The browser refused the copy. Select the key above and copy it."
          : null}
      </p>
      <div>
        <button type="button" className={kit["primary"]} onClick={onDismiss}>
          I&rsquo;ve saved it
        </button>
      </div>
    </section>
  );
};

const NewKey = ({
  closedBecause,
  onCreated,
}: {
  /** Why the form is closed to the caller, when it is. */
  readonly closedBecause: string | undefined;
  readonly onCreated: (created: CreatedProxyKey) => void;
}) => {
  const ids = useId();
  const create = useAction(createProxyKeyAtom);
  const [name, setName] = useState("");
  const [expires, setExpires] = useState("");
  const [tried, setTried] = useState(false);
  const [note, setNote] = useState<Note | undefined>(undefined);
  const now = Date.now();
  const nameIssue = tried ? keyNameProblem(name) : undefined;
  const expiryIssue = expiryProblem(expires, now);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTried(true);
    setNote(undefined);

    if (keyNameProblem(name) !== undefined || expiryProblem(expires, Date.now()) !== undefined)
      return;
    const expiresAt = expiryIso(expires, Date.now());

    const outcome = await create.run({
      payload:
        expiresAt === undefined
          ? { name: name.trim() }
          : { name: name.trim(), expires_at: expiresAt },
      reactivityKeys: PROXY_KEYS,
    });

    if (outcome.ok) {
      setName("");
      setExpires("");
      setTried(false);
      onCreated(outcome.value);
    } else {
      setNote({
        tone: "problem",
        text: keyProblem(outcome.error, outcome.message, outcome.detail),
      });
    }
  };

  return (
    <>
      <form className={styles["form"]} onSubmit={submit} noValidate aria-label="Create a proxy key">
        <div className={styles["formRow"]}>
          <div className={kit["field"]}>
            <label className={kit["fieldLabel"]} htmlFor={`${ids}-name`}>
              Name
            </label>
            <input
              id={`${ids}-name`}
              className={kit["input"]}
              autoComplete="off"
              placeholder="laptop, pi"
              value={name}
              disabled={closedBecause !== undefined}
              aria-invalid={nameIssue !== undefined}
              aria-describedby={`${ids}-hint`}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className={`${kit["field"]} ${styles["expiry"]}`}>
            <label className={kit["fieldLabel"]} htmlFor={`${ids}-expires`}>
              Expires (optional)
            </label>
            <input
              id={`${ids}-expires`}
              className={kit["input"]}
              type="date"
              min={todayInput(now)}
              value={expires}
              disabled={closedBecause !== undefined}
              aria-invalid={expiryIssue !== undefined}
              aria-describedby={`${ids}-hint`}
              onChange={(event) => setExpires(event.target.value)}
            />
          </div>
          <button
            type="submit"
            className={kit["primary"]}
            disabled={closedBecause !== undefined || create.busy}
            aria-busy={create.busy}
          >
            <KeyRound aria-hidden="true" size={18} strokeWidth={2.25} />
            {create.busy ? "Creating…" : "Create key"}
          </button>
        </div>
        <p
          id={`${ids}-hint`}
          className={
            nameIssue === undefined && expiryIssue === undefined ? kit["muted"] : kit["fieldError"]
          }
        >
          {closedBecause ??
            nameIssue ??
            expiryIssue ??
            "Name it after where it is used. A key without an expiry works until you revoke it; one with an expiry stops working at the end of that day."}
        </p>
      </form>
      <NoteLine note={note} what="create the key" />
    </>
  );
};

const Status = ({ keyView, now }: { readonly keyView: ProxyKeyView; readonly now: number }) => {
  const status = keyStatus(keyView, now);
  const revoked = status === "revoked" ? revokedText(keyView) : undefined;

  return (
    <>
      {statusLabel(status)}
      {revoked === undefined ? null : <span className={styles["secondary"]}>{revoked}</span>}
    </>
  );
};

const KeyTable = ({
  keys,
  now,
  withMember,
  busy,
  onRevoke,
}: {
  readonly keys: ReadonlyArray<ProxyKeyView>;
  readonly now: number;
  readonly withMember: boolean;
  readonly busy: boolean;
  readonly onRevoke: (key: ProxyKeyView) => void;
}) => (
  <div className={styles["scroll"]} role="region" aria-label="Proxy keys" tabIndex={0}>
    <table className={styles["table"]}>
      <thead>
        <tr>
          <th scope="col">Key</th>
          {withMember ? <th scope="col">Member</th> : null}
          <th scope="col">Created</th>
          <th scope="col">Last used</th>
          <th scope="col">Expires</th>
          <th scope="col">Status</th>
          <th scope="col">
            <span className={kit["visuallyHidden"]}>Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {keys.map((key) => (
          <tr
            key={key.id}
            className={keyStatus(key, now) === "active" ? undefined : styles["gone"]}
          >
            <th scope="row" className={styles["name"]}>
              {key.name}
              <span className={styles["secondary"]}>{key.prefix}…</span>
            </th>
            {withMember ? (
              <td className={styles["member"]}>
                {memberName(key)}
                {key.mine ? <span className={styles["secondary"]}>You</span> : null}
              </td>
            ) : null}
            <td>{createdText(key)}</td>
            <td>{lastUsedText(key, now)}</td>
            <td>{expiresText(key)}</td>
            <td>
              <Status keyView={key} now={now} />
            </td>
            <td className={styles["actions"]}>
              {canRevoke(key, now) ? (
                <button
                  type="button"
                  className={styles["revoke"]}
                  aria-label={`Revoke ${key.name}`}
                  disabled={busy}
                  onClick={() => onRevoke(key)}
                >
                  Revoke
                </button>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const Keys = ({ caller }: { readonly caller: Caller }) => {
  const result = useAtomValue(proxyKeysAtom);
  const retry = useAtomRefresh(proxyKeysAtom);
  const revoke = useAction(revokeProxyKeyAtom);
  const [filter, setFilter] = useState<KeyFilter>("active");
  const [confirm, setConfirm] = useState<ConfirmRequest | undefined>(undefined);
  const [note, setNote] = useState<Note | undefined>(undefined);
  const every = seesEveryProxyKey(caller);

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
  const all = sortKeys(result.value.keys, now);
  const shown = filterKeys(all, filter, now);
  const hasGone = filterKeys(all, "active", now).length < all.length;

  const askRevoke = (key: ProxyKeyView) => {
    setNote(undefined);

    setConfirm({
      title: `Revoke ${key.name}?`,
      body: (
        <p>
          {key.mine ? "" : `It belongs to ${memberName(key)}. `}
          Anything that sends {key.prefix}… is refused from its next request on. This cannot be
          undone; create a new key to replace it.
        </p>
      ),
      action: "Revoke key",
      busyAction: "Revoking…",
      run: async () => {
        const outcome = await revoke.run({ params: { id: key.id }, reactivityKeys: PROXY_KEYS });

        setNote(
          outcome.ok
            ? { tone: "done", text: `Revoked ${key.name}.` }
            : {
                tone: "problem",
                text: keyProblem(outcome.error, outcome.message, outcome.detail),
              },
        );
      },
    });
  };

  return (
    <>
      {hasGone ? (
        <div className={kit["tabs"]} role="radiogroup" aria-label="Show">
          {KEY_FILTERS.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              role="radio"
              aria-checked={filter === candidate.id}
              className={kit["tab"]}
              onClick={() => setFilter(candidate.id)}
            >
              {candidate.label}
              <span className={kit["tabCount"]}>
                {formatCount(filterKeys(all, candidate.id, now).length)}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      {shown.length === 0 ? (
        <p className={styles["empty"]}>
          {all.length === 0
            ? every
              ? "No one has created a proxy key in this org yet."
              : "You have no proxy keys yet. Create one above to use the proxy from a coding agent."
            : "No key works any more. Create one above, or choose All to see the old ones."}
        </p>
      ) : (
        <KeyTable
          keys={shown}
          now={now}
          withMember={showMemberColumn(all, every)}
          busy={revoke.busy}
          onRevoke={askRevoke}
        />
      )}
      <NoteLine note={note} what="revoke the key" />
      <ConfirmDialog request={confirm} busy={revoke.busy} onClose={() => setConfirm(undefined)} />
    </>
  );
};

const Usage = () => (
  <>
    <p className={styles["lead"]}>
      Send the key to {window.location.origin} the way the client&rsquo;s own API does:
    </p>
    <dl className={styles["headers"]}>
      {KEY_HEADERS.map((row) => (
        <div key={row.clients} className={styles["header"]}>
          <dt>{row.clients}</dt>
          <dd>{row.send}</dd>
        </div>
      ))}
    </dl>
  </>
);

export const ProxyKeysPage = () => {
  usePageTitle("Proxy keys");
  const role = useRole();
  const me = useAtomValue(meAtom);
  const [created, setCreated] = useState<CreatedProxyKey | undefined>(undefined);

  if (role.kind !== "ready") return null;
  const { caller } = role;
  const every = seesEveryProxyKey(caller);
  const closedBecause = AsyncResult.isSuccess(me) ? notMemberNote(me.value) : undefined;

  return (
    <div className={kit["page"]}>
      <header className={styles["head"]}>
        <h1 className={styles["title"]}>Proxy keys</h1>
        <p className={styles["intro"]}>
          A proxy key lets a coding agent or script use this org&rsquo;s proxy without an Access
          sign-in. Each key belongs to the member who created it, and anything holding it can use
          the proxy as that member.{" "}
          {every
            ? `You are ${roleAs(caller.role)}, so you also see and revoke every member's keys.`
            : "You see and revoke your own keys."}
        </p>
      </header>
      {created === undefined ? null : (
        <Reveal created={created} onDismiss={() => setCreated(undefined)} />
      )}
      <Section title="New key">
        <NewKey closedBecause={closedBecause} onCreated={setCreated} />
      </Section>
      <Section title={every ? "Keys in this org" : "Your keys"}>
        <Keys caller={caller} />
      </Section>
      <Section title="Using a key">
        <Usage />
      </Section>
    </div>
  );
};
