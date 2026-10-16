// The other members' private accounts, as an org admin sees them: existence only (ADR 0023).
import type { LimitedCredentialEntry } from "@commissary/contract/credentials";
import { CREDENTIALS, removeAtom, setDisabledAtom } from "../api/client.ts";
import { PrivateRows } from "../components/PrivateRows.tsx";
import { providerName } from "../lib/providers.ts";
import { useAction } from "../lib/use-action.ts";

export const OtherPrivateAccounts = ({
  others,
}: {
  readonly others: ReadonlyArray<LimitedCredentialEntry>;
}) => {
  const toggle = useAction(setDisabledAtom);
  const remove = useAction(removeAtom);

  return (
    <PrivateRows
      title="Members' private accounts"
      noun="account"
      rows={others.map((other) => ({
        key: other.name,
        provider: providerName(other.provider),
        label: other.label,
        owner: other.owner.email ?? other.owner.member_id,
        disabled: other.disabled,
      }))}
      onDisable={async (row, disabled) => {
        const outcome = await toggle.run({
          payload: { name: row.key, disabled },
          reactivityKeys: CREDENTIALS,
        });

        return outcome.ok ? { ok: true } : { ok: false, message: outcome.message };
      }}
      onRemove={async (row) => {
        const outcome = await remove.run({ query: { name: row.key }, reactivityKeys: CREDENTIALS });

        return outcome.ok ? { ok: true } : { ok: false, message: outcome.message };
      }}
    />
  );
};
