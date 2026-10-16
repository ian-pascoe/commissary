// Putting a member on a team and taking them off it: one write each, reported in the section's note. The people list
// and the teams list both offer it.
import type { MemberView, TeamView } from "@commissary/contract/members";
import { addTeamMemberAtom, MEMBERS, removeTeamMemberAtom } from "../api/client.ts";
import { useAction } from "../lib/use-action.ts";
import type { useNote } from "./MembersNote.tsx";

export const useTeamMembership = ({ settle, clear }: ReturnType<typeof useNote>) => {
  const add = useAction(addTeamMemberAtom);
  const remove = useAction(removeTeamMemberAtom);

  return {
    busy: add.busy || remove.busy,
    join: async (team: TeamView, member: MemberView) => {
      clear();

      settle(
        await add.run({
          params: { id: team.id },
          payload: { member_id: member.id },
          reactivityKeys: MEMBERS,
        }),
        `Added ${member.email} to ${team.name}.`,
      );
    },
    leave: async (team: TeamView, member: MemberView) => {
      clear();

      settle(
        await remove.run({
          params: { id: team.id, memberId: member.id },
          reactivityKeys: MEMBERS,
        }),
        `Took ${member.email} off ${team.name}.`,
      );
    },
  } as const;
};
