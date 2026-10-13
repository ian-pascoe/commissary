// Service tokens: Cloudflare Access service tokens registered to the org with a role, for scripts that call the
// management API. A role above member is granted only by a service token that is an org owner or by a platform admin,
// so a person who is an org owner registers member tokens here and says so; the server refuses the rest.
import { Plus, X } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import type { ServiceTokenView } from "#contract/members.ts";
import {
  MEMBERS,
  registerServiceTokenAtom,
  removeServiceTokenAtom,
  updateServiceTokenAtom,
} from "../api/client.ts";
import { ConfirmDialog, type ConfirmRequest } from "../components/Confirm.tsx";
import { kit } from "../components/Kit.tsx";
import { clientIdProblem, sortTokens, tokenName } from "../lib/members.ts";
import {
  type Caller,
  canRemoveToken,
  type OrgRole,
  roleOf,
  roleAs,
  roleLabel,
  tokenRoleChanges,
  tokenRoles,
} from "../lib/role.ts";
import { useAction } from "../lib/use-action.ts";
import styles from "./Members.module.css";
import { NoteLine, useNote } from "./MembersNote.tsx";

/** Why the role picker offers what it does, said when it offers only member. */
const MEMBER_ONLY =
  "A role above member needs a service token that is an org owner, or a platform admin. From this page you register member tokens; to register an admin or owner token, use the management API from an owner service token.";

const RegisterToken = ({
  caller,
  busy,
  onRegister,
}: {
  readonly caller: Caller;
  readonly busy: boolean;
  readonly onRegister: (clientId: string, name: string, role: OrgRole) => Promise<boolean>;
}) => {
  const ids = useId();
  const roles = tokenRoles(caller);
  const [clientId, setClientId] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<OrgRole>("member");
  const [tried, setTried] = useState(false);
  const problem = tried ? clientIdProblem(clientId) : undefined;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTried(true);

    if (clientIdProblem(clientId) !== undefined) return;

    if (await onRegister(clientId.trim(), name.trim(), role)) {
      setClientId("");
      setName("");
      setTried(false);
    }
  };

  return (
    <form
      className={styles["form"]}
      onSubmit={submit}
      noValidate
      aria-label="Register a service token"
    >
      <div className={styles["formRow"]}>
        <div className={kit["field"]}>
          <label className={kit["fieldLabel"]} htmlFor={`${ids}-id`}>
            Client ID
          </label>
          <input
            id={`${ids}-id`}
            className={kit["input"]}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="0123abcd.access"
            value={clientId}
            aria-invalid={problem !== undefined}
            aria-describedby={`${ids}-hint`}
            onChange={(event) => setClientId(event.target.value)}
          />
        </div>
        <div className={kit["field"]}>
          <label className={kit["fieldLabel"]} htmlFor={`${ids}-name`}>
            Name (optional)
          </label>
          <input
            id={`${ids}-name`}
            className={kit["input"]}
            autoComplete="off"
            maxLength={100}
            placeholder="CI"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        {roles.length > 1 ? (
          <div className={kit["field"]}>
            <label className={kit["fieldLabel"]} htmlFor={`${ids}-role`}>
              Role
            </label>
            <select
              id={`${ids}-role`}
              className={kit["input"]}
              value={role}
              onChange={(event) => setRole(roleOf(event.target.value) ?? role)}
            >
              {roles.map((choice) => (
                <option key={choice} value={choice}>
                  {roleLabel(choice)}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <button type="submit" className={kit["secondary"]} disabled={busy} aria-busy={busy}>
          <Plus aria-hidden="true" size={16} strokeWidth={2.25} />
          {busy ? "Registering…" : "Register token"}
        </button>
      </div>
      <p id={`${ids}-hint`} className={problem === undefined ? kit["muted"] : kit["fieldError"]}>
        {problem ??
          (roles.length > 1
            ? "The Client ID of an Access service token, as the Zero Trust dashboard shows it. A token belongs to one org."
            : `The Client ID of an Access service token, as the Zero Trust dashboard shows it; it joins as a member token. ${MEMBER_ONLY}`)}
      </p>
    </form>
  );
};

const TokenRow = ({
  token,
  caller,
  busy,
  onRole,
  onRemove,
}: {
  readonly token: ServiceTokenView;
  readonly caller: Caller;
  readonly busy: boolean;
  readonly onRole: (role: OrgRole) => void;
  readonly onRemove: () => void;
}) => {
  const changes = tokenRoleChanges(caller, token.role);

  return (
    <tr>
      <th scope="row" className={styles["name"]}>
        {tokenName(token)}
        {token.name === "" ? null : <span className={styles["secondary"]}>{token.client_id}</span>}
      </th>
      <td>
        {changes.length === 0 ? (
          roleLabel(token.role)
        ) : (
          <select
            className={styles["pick"]}
            aria-label={`Role of ${tokenName(token)}`}
            value={token.role}
            disabled={busy}
            onChange={(event) => {
              const next = roleOf(event.target.value);

              if (next !== undefined) onRole(next);
            }}
          >
            <option value={token.role}>{roleLabel(token.role)}</option>
            {changes.map((role) => (
              <option key={role} value={role}>
                {roleLabel(role)}
              </option>
            ))}
          </select>
        )}
      </td>
      <td className={styles["actions"]}>
        {canRemoveToken(caller, token.role) ? (
          <button
            type="button"
            className={styles["icon"]}
            aria-label={`Remove ${tokenName(token)}`}
            title="Remove"
            disabled={busy}
            onClick={onRemove}
          >
            <X aria-hidden="true" size={18} strokeWidth={2.25} />
          </button>
        ) : null}
      </td>
    </tr>
  );
};

export const ServiceTokens = ({
  tokens,
  caller,
}: {
  readonly tokens: ReadonlyArray<ServiceTokenView>;
  readonly caller: Caller;
}) => {
  const register = useAction(registerServiceTokenAtom);
  const update = useAction(updateServiceTokenAtom);
  const remove = useAction(removeServiceTokenAtom);
  const { note, settle, clear } = useNote();
  const [confirm, setConfirm] = useState<ConfirmRequest | undefined>(undefined);
  const busy = register.busy || update.busy || remove.busy;

  const askRemove = (token: ServiceTokenView) => {
    clear();

    setConfirm({
      title: `Remove ${tokenName(token)}?`,
      body: (
        <p>
          Scripts that sign in with this token lose their access to the org on their next request.
          {token.role === "member"
            ? ""
            : " Registering it again with this role needs an owner service token or a platform admin."}
        </p>
      ),
      action: "Remove token",
      busyAction: "Removing…",
      run: async () => {
        settle(
          await remove.run({ params: { clientId: token.client_id }, reactivityKeys: MEMBERS }),
          `Removed ${tokenName(token)}.`,
        );
      },
    });
  };

  return (
    <>
      {tokens.length === 0 ? (
        <p className={styles["empty"]}>
          No service tokens yet. Register one to let a script use this org&rsquo;s management API.
        </p>
      ) : (
        <table className={styles["table"]}>
          <caption className={kit["visuallyHidden"]}>Service tokens of the org</caption>
          <thead>
            <tr>
              <th scope="col">Token</th>
              <th scope="col">Role</th>
              <th scope="col">
                <span className={kit["visuallyHidden"]}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {sortTokens(tokens).map((token) => (
              <TokenRow
                key={token.client_id}
                token={token}
                caller={caller}
                busy={busy}
                onRole={async (role) => {
                  clear();

                  settle(
                    await update.run({
                      params: { clientId: token.client_id },
                      payload: { role },
                      reactivityKeys: MEMBERS,
                    }),
                    `${tokenName(token)} is now ${roleAs(role)} token.`,
                  );
                }}
                onRemove={() => askRemove(token)}
              />
            ))}
          </tbody>
        </table>
      )}
      <RegisterToken
        caller={caller}
        busy={register.busy}
        onRegister={async (clientId, name, role) => {
          clear();

          return settle(
            await register.run({
              payload: { client_id: clientId, ...(name === "" ? {} : { name }), role },
              reactivityKeys: MEMBERS,
            }),
            `Registered ${name === "" ? clientId : name} as ${roleAs(role)} token.`,
          );
        }}
      />
      <NoteLine note={note} />
      <ConfirmDialog request={confirm} busy={remove.busy} onClose={() => setConfirm(undefined)} />
    </>
  );
};
