// The people of the org: their role and teams, who may be added, changed and removed (by the caller's role), and the
// form that adds one. A person gets access the next time they sign in through Access; no email is sent.
import { Plus, X } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import type { MemberView, TeamView } from "@commissary/contract/members";
import { addMemberAtom, MEMBERS, removeMemberAtom, updateMemberAtom } from "../api/client.ts";
import { ConfirmDialog, type ConfirmRequest } from "../components/Confirm.tsx";
import { kit } from "../components/Kit.tsx";
import {
  emailProblem,
  normalizeEmail,
  roleCounts,
  sortMembers,
  teamsOfMember,
  teamsToJoin,
} from "../lib/members.ts";
import {
  addableRoles,
  type Caller,
  canChangeRoles,
  canManageTeams,
  canRemove,
  type OrgRole,
  roleOf,
  ROLES,
  roleAs,
  roleLabel,
  roleSummary,
} from "../lib/role.ts";
import { useAction } from "../lib/use-action.ts";
import styles from "./Members.module.css";
import { useTeamMembership } from "./MembersMembership.ts";
import { NoteLine, useNote } from "./MembersNote.tsx";

const AddMember = ({
  caller,
  onAdd,
  busy,
}: {
  readonly caller: Caller;
  readonly busy: boolean;
  readonly onAdd: (email: string, role: OrgRole) => Promise<boolean>;
}) => {
  const ids = useId();
  const roles = addableRoles(caller);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<OrgRole>("member");
  const [tried, setTried] = useState(false);
  const problem = tried ? emailProblem(email) : undefined;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTried(true);

    if (emailProblem(email) !== undefined) return;

    if (await onAdd(normalizeEmail(email), role)) {
      setEmail("");
      setTried(false);
    }
  };

  return (
    <form className={styles["form"]} onSubmit={submit} noValidate aria-label="Add a member">
      <div className={styles["formRow"]}>
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
            placeholder="person@example.com"
            value={email}
            aria-invalid={problem !== undefined}
            aria-describedby={`${ids}-hint`}
            onChange={(event) => setEmail(event.target.value)}
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
          {busy ? "Adding…" : "Add member"}
        </button>
      </div>
      <p id={`${ids}-hint`} className={problem === undefined ? kit["muted"] : kit["fieldError"]}>
        {problem ??
          (roles.length > 1
            ? `${roleSummary(role)} They get access the next time they sign in; no email is sent.`
            : "They join as a plain member and get access the next time they sign in; no email is sent. Only an org owner adds org admins and owners.")}
      </p>
    </form>
  );
};

/** One team chip on a member's row: the team, and (for those who manage teams) a button to take the member off it. */
const TeamChip = ({
  team,
  removable,
  busy,
  onRemove,
}: {
  readonly team: TeamView;
  readonly removable: boolean;
  readonly busy: boolean;
  readonly onRemove: () => void;
}) => (
  <li className={styles["chip"]}>
    {team.name}
    {removable ? (
      <button
        type="button"
        className={styles["chipRemove"]}
        aria-label={`Take them off ${team.name}`}
        disabled={busy}
        onClick={onRemove}
      >
        <X aria-hidden="true" size={14} strokeWidth={2.5} />
      </button>
    ) : null}
  </li>
);

const MemberRow = ({
  member,
  teams,
  caller,
  busy,
  onRole,
  onRemove,
  onJoin,
  onLeave,
}: {
  readonly member: MemberView;
  readonly teams: ReadonlyArray<TeamView>;
  readonly caller: Caller;
  readonly busy: boolean;
  readonly onRole: (role: OrgRole) => void;
  readonly onRemove: () => void;
  readonly onJoin: (team: TeamView) => void;
  readonly onLeave: (team: TeamView) => void;
}) => {
  const manageTeams = canManageTeams(caller);
  const joinable = teamsToJoin(member, teams);

  return (
    <tr>
      <th scope="row" className={styles["name"]}>
        {member.email}
      </th>
      <td>
        {canChangeRoles(caller) ? (
          <select
            className={styles["pick"]}
            aria-label={`Role of ${member.email}`}
            value={member.role}
            disabled={busy}
            onChange={(event) => {
              const next = roleOf(event.target.value);

              if (next !== undefined) onRole(next);
            }}
          >
            {ROLES.map((role) => (
              <option key={role} value={role}>
                {roleLabel(role)}
              </option>
            ))}
          </select>
        ) : (
          roleLabel(member.role)
        )}
      </td>
      <td className={styles["wide"]}>
        <ul className={styles["chips"]}>
          {teamsOfMember(member, teams).map((team) => (
            <TeamChip
              key={team.id}
              team={team}
              removable={manageTeams}
              busy={busy}
              onRemove={() => onLeave(team)}
            />
          ))}
        </ul>
        {manageTeams && joinable.length > 0 ? (
          <select
            className={styles["pick"]}
            aria-label={`Add ${member.email} to a team`}
            value=""
            disabled={busy}
            onChange={(event) => {
              const team = joinable.find((candidate) => candidate.id === event.target.value);

              if (team !== undefined) onJoin(team);
            }}
          >
            <option value="">Add to a team…</option>
            {joinable.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </select>
        ) : null}
      </td>
      <td className={styles["actions"]}>
        {canRemove(caller, member.role) ? (
          <button
            type="button"
            className={styles["icon"]}
            aria-label={`Remove ${member.email}`}
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

export const People = ({
  members,
  teams,
  caller,
}: {
  readonly members: ReadonlyArray<MemberView>;
  readonly teams: ReadonlyArray<TeamView>;
  readonly caller: Caller;
}) => {
  const add = useAction(addMemberAtom);
  const update = useAction(updateMemberAtom);
  const remove = useAction(removeMemberAtom);
  const noteState = useNote();
  const { note, settle, clear } = noteState;
  const membership = useTeamMembership(noteState);
  const [confirm, setConfirm] = useState<ConfirmRequest | undefined>(undefined);
  const busy = add.busy || update.busy || remove.busy || membership.busy;

  const askRemove = (member: MemberView) => {
    clear();

    setConfirm({
      title: `Remove ${member.email}?`,
      body: (
        <p>
          They lose access to this org on their next request.{" "}
          {member.role === "member"
            ? "You can add them again later."
            : `They are ${roleAs(member.role)} now; adding them back as one is for an owner.`}
        </p>
      ),
      action: "Remove member",
      busyAction: "Removing…",
      run: async () => {
        settle(
          await remove.run({ params: { id: member.id }, reactivityKeys: MEMBERS }),
          `Removed ${member.email}.`,
        );
      },
    });
  };

  return (
    <>
      <p className={kit["muted"]}>{roleCounts(members)}</p>
      <table className={styles["table"]}>
        <caption className={kit["visuallyHidden"]}>Members of the org</caption>
        <thead>
          <tr>
            <th scope="col">Member</th>
            <th scope="col">Role</th>
            <th scope="col" className={styles["wide"]}>
              Teams
            </th>
            <th scope="col">
              <span className={kit["visuallyHidden"]}>Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {sortMembers(members).map((member) => (
            <MemberRow
              key={member.id}
              member={member}
              teams={teams}
              caller={caller}
              busy={busy}
              onRole={async (role) => {
                clear();

                settle(
                  await update.run({
                    params: { id: member.id },
                    payload: { role },
                    reactivityKeys: MEMBERS,
                  }),
                  `${member.email} is now ${roleAs(role)}.`,
                );
              }}
              onRemove={() => askRemove(member)}
              onJoin={(team) => membership.join(team, member)}
              onLeave={(team) => membership.leave(team, member)}
            />
          ))}
        </tbody>
      </table>
      <AddMember
        caller={caller}
        busy={add.busy}
        onAdd={async (email, role) => {
          clear();

          return settle(
            await add.run({ payload: { email, role }, reactivityKeys: MEMBERS }),
            `Added ${email}. They get access the next time they sign in.`,
          );
        }}
      />
      <NoteLine note={note} />
      <ConfirmDialog request={confirm} busy={remove.busy} onClose={() => setConfirm(undefined)} />
    </>
  );
};
