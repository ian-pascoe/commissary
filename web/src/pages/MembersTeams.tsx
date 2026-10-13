// Teams: named groups of members, created, renamed and deleted by admins. A team has no powers of its own; it only
// groups people. A member's teams show on their row in the people list as well.
import { Check, Pencil, Plus, X } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import type { MemberView, TeamView } from "#contract/members.ts";
import {
  addTeamMemberAtom,
  createTeamAtom,
  deleteTeamAtom,
  MEMBERS,
  removeTeamMemberAtom,
  renameTeamAtom,
} from "../api/client.ts";
import { ConfirmDialog, type ConfirmRequest } from "../components/Confirm.tsx";
import { kit } from "../components/Kit.tsx";
import { membersOfTeam, sortMembers, sortTeams, teamNameProblem } from "../lib/members.ts";
import { useAction } from "../lib/use-action.ts";
import styles from "./Members.module.css";
import { NoteLine, useNote } from "./MembersNote.tsx";

/** A name field with its problem, shown once the form has been tried. */
const NameForm = ({
  label,
  initial,
  others,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
}: {
  readonly label: string;
  readonly initial: string;
  readonly others: ReadonlyArray<string>;
  readonly submitLabel: string;
  readonly busy: boolean;
  readonly onSubmit: (name: string) => Promise<boolean>;
  readonly onCancel?: () => void;
}) => {
  const ids = useId();
  const [name, setName] = useState(initial);
  const [tried, setTried] = useState(false);
  const problem = tried ? teamNameProblem(name, others) : undefined;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTried(true);

    if (teamNameProblem(name, others) !== undefined) return;

    if (await onSubmit(name.trim())) {
      setName(initial);
      setTried(false);
    }
  };

  return (
    <form className={styles["inline"]} onSubmit={submit} noValidate aria-label={label}>
      <div className={kit["field"]}>
        <label className={kit["fieldLabel"]} htmlFor={`${ids}-name`}>
          {label}
        </label>
        <input
          id={`${ids}-name`}
          className={kit["input"]}
          value={name}
          maxLength={100}
          autoComplete="off"
          aria-invalid={problem !== undefined}
          aria-describedby={`${ids}-problem`}
          onChange={(event) => setName(event.target.value)}
        />
        <span id={`${ids}-problem`} className={kit["fieldError"]}>
          {problem}
        </span>
      </div>
      <button type="submit" className={kit["secondary"]} disabled={busy} aria-busy={busy}>
        {initial === "" ? (
          <Plus aria-hidden="true" size={16} strokeWidth={2.25} />
        ) : (
          <Check aria-hidden="true" size={16} strokeWidth={2.25} />
        )}
        {submitLabel}
      </button>
      {onCancel === undefined ? null : (
        <button type="button" className={styles["quiet"]} onClick={onCancel}>
          Cancel
        </button>
      )}
    </form>
  );
};

const Team = ({
  team,
  teams,
  members,
  busy,
  renaming,
  onRename,
  onStartRename,
  onStopRename,
  onDelete,
  onJoin,
  onLeave,
}: {
  readonly team: TeamView;
  readonly teams: ReadonlyArray<TeamView>;
  readonly members: ReadonlyArray<MemberView>;
  readonly busy: boolean;
  readonly renaming: boolean;
  readonly onRename: (name: string) => Promise<boolean>;
  readonly onStartRename: () => void;
  readonly onStopRename: () => void;
  readonly onDelete: () => void;
  readonly onJoin: (member: MemberView) => void;
  readonly onLeave: (member: MemberView) => void;
}) => {
  const inTeam = membersOfTeam(team, members);
  const others = sortMembers(members).filter((member) => !team.members.includes(member.id));

  return (
    <li className={styles["team"]}>
      {renaming ? (
        <NameForm
          label="Team name"
          initial={team.name}
          others={teams.filter((other) => other.id !== team.id).map((other) => other.name)}
          submitLabel="Save name"
          busy={busy}
          onSubmit={async (name) => {
            const saved = await onRename(name);

            if (saved) onStopRename();

            return saved;
          }}
          onCancel={onStopRename}
        />
      ) : (
        <div className={styles["teamHead"]}>
          <h3 className={styles["teamName"]}>{team.name}</h3>
          <span className={kit["muted"]}>
            {inTeam.length === 1 ? "1 member" : `${inTeam.length} members`}
          </span>
          <div className={styles["teamActions"]}>
            <button
              type="button"
              className={styles["icon"]}
              aria-label={`Rename ${team.name}`}
              title="Rename"
              disabled={busy}
              onClick={onStartRename}
            >
              <Pencil aria-hidden="true" size={16} strokeWidth={2.25} />
            </button>
            <button
              type="button"
              className={styles["icon"]}
              aria-label={`Delete ${team.name}`}
              title="Delete"
              disabled={busy}
              onClick={onDelete}
            >
              <X aria-hidden="true" size={18} strokeWidth={2.25} />
            </button>
          </div>
        </div>
      )}
      <ul className={styles["chips"]}>
        {inTeam.map((member) => (
          <li key={member.id} className={styles["chip"]}>
            {member.email}
            <button
              type="button"
              className={styles["chipRemove"]}
              aria-label={`Take ${member.email} off ${team.name}`}
              disabled={busy}
              onClick={() => onLeave(member)}
            >
              <X aria-hidden="true" size={14} strokeWidth={2.5} />
            </button>
          </li>
        ))}
        {others.length === 0 ? null : (
          <li>
            <select
              className={styles["pick"]}
              aria-label={`Add a member to ${team.name}`}
              value=""
              disabled={busy}
              onChange={(event) => {
                const member = others.find((candidate) => candidate.id === event.target.value);

                if (member !== undefined) onJoin(member);
              }}
            >
              <option value="">Add a member…</option>
              {others.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.email}
                </option>
              ))}
            </select>
          </li>
        )}
      </ul>
    </li>
  );
};

export const Teams = ({
  teams,
  members,
}: {
  readonly teams: ReadonlyArray<TeamView>;
  readonly members: ReadonlyArray<MemberView>;
}) => {
  const create = useAction(createTeamAtom);
  const rename = useAction(renameTeamAtom);
  const remove = useAction(deleteTeamAtom);
  const join = useAction(addTeamMemberAtom);
  const leave = useAction(removeTeamMemberAtom);
  const { note, settle, clear } = useNote();
  const [renaming, setRenaming] = useState<string | undefined>(undefined);
  const [confirm, setConfirm] = useState<ConfirmRequest | undefined>(undefined);
  const busy = create.busy || rename.busy || remove.busy || join.busy || leave.busy;

  const askDelete = (team: TeamView) => {
    clear();

    setConfirm({
      title: `Delete the team ${team.name}?`,
      body: <p>The team goes; its members stay in the org, only off this team.</p>,
      action: "Delete team",
      busyAction: "Deleting…",
      run: async () => {
        settle(
          await remove.run({ params: { id: team.id }, reactivityKeys: MEMBERS }),
          `Deleted ${team.name}.`,
        );
      },
    });
  };

  return (
    <>
      {teams.length === 0 ? (
        <p className={styles["empty"]}>No teams yet. Create one to group members.</p>
      ) : (
        <ul className={styles["teams"]}>
          {sortTeams(teams).map((team) => (
            <Team
              key={team.id}
              team={team}
              teams={teams}
              members={members}
              busy={busy}
              renaming={renaming === team.id}
              onStartRename={() => {
                clear();
                setRenaming(team.id);
              }}
              onStopRename={() => setRenaming(undefined)}
              onRename={async (name) => {
                clear();

                return settle(
                  await rename.run({
                    params: { id: team.id },
                    payload: { name },
                    reactivityKeys: MEMBERS,
                  }),
                  `Renamed the team to ${name}.`,
                );
              }}
              onDelete={() => askDelete(team)}
              onJoin={async (member) => {
                clear();

                settle(
                  await join.run({
                    params: { id: team.id },
                    payload: { member_id: member.id },
                    reactivityKeys: MEMBERS,
                  }),
                  `Added ${member.email} to ${team.name}.`,
                );
              }}
              onLeave={async (member) => {
                clear();

                settle(
                  await leave.run({
                    params: { id: team.id, memberId: member.id },
                    reactivityKeys: MEMBERS,
                  }),
                  `Took ${member.email} off ${team.name}.`,
                );
              }}
            />
          ))}
        </ul>
      )}
      <NameForm
        label="New team"
        initial=""
        others={teams.map((team) => team.name)}
        submitLabel={create.busy ? "Creating…" : "Create team"}
        busy={create.busy}
        onSubmit={async (name) => {
          clear();

          return settle(
            await create.run({ payload: { name }, reactivityKeys: MEMBERS }),
            `Created the team ${name}.`,
          );
        }}
      />
      <NoteLine note={note} />
      <ConfirmDialog request={confirm} busy={remove.busy} onClose={() => setConfirm(undefined)} />
    </>
  );
};
