// The other members' private API key groups, as an org admin sees them: existence only (ADR 0023).
import type { LimitedKeyGroup } from "#contract/api-keys.ts";
import { API_KEYS, deleteKeyGroupAtom } from "../api/client.ts";
import { PrivateRows } from "../components/PrivateRows.tsx";
import { familyName } from "../lib/keys.ts";
import { useAction } from "../lib/use-action.ts";

export const OtherPrivateKeyGroups = ({
  others,
}: {
  readonly others: ReadonlyArray<LimitedKeyGroup>;
}) => {
  const remove = useAction(deleteKeyGroupAtom);

  return (
    <PrivateRows
      title="Members' private API keys"
      noun="API key group"
      rows={others.map((other) => ({
        key: other.id,
        provider: familyName(other.family),
        label: other.label,
        owner: other.owner.email ?? other.owner.member_id,
      }))}
      onRemove={async (row) => {
        const target = others.find((other) => other.id === row.key);

        if (target === undefined) return { ok: false, message: "That group is gone already." };

        const outcome = await remove.run({
          payload: {
            family: target.family,
            id: target.id,
            revision: target.revision,
            private: true,
          },
          reactivityKeys: API_KEYS,
        });

        return outcome.ok ? { ok: true } : { ok: false, message: outcome.message };
      }}
    />
  );
};
