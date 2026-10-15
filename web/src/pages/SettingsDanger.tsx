// Export and deletion of the org (ADR 0027). Org admins download an export (the org, its config with every secret as a
// preview, prices, credential summaries and who belongs; never a token or key). Org owners and platform admins delete
// the org by typing its name: immediate and permanent, with no grace period and no restore. The first org holds the
// deployment's own settings and is never deleted. After a deletion the panel reloads at its root.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Download, Trash2 } from "lucide-react";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import type { OrgView } from "#contract/orgs.ts";
import { deleteOrgAtom, exportOrgAtom, orgAtom } from "../api/client.ts";
import { kit, Problem } from "../components/Kit.tsx";
import { TypedConfirm } from "../components/TypedConfirm.tsx";
import { saveJson } from "../lib/download.ts";
import { failureMessage } from "../lib/failure.ts";
import { exportFileName } from "../lib/retention.ts";
import { atLeast } from "../lib/role.ts";
import { useAction } from "../lib/use-action.ts";
import { useRole } from "../lib/use-role.ts";
import styles from "./SettingsOrg.module.css";

/** The deployment's first org: its id, which the server never deletes. */
const GLOBAL_ORG_ID = "global";

const ExportRow = ({ org }: { readonly org: OrgView }) => {
  const read = useAction(exportOrgAtom);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const download = async () => {
    setProblem(undefined);
    const outcome = await read.run({});

    if (outcome.ok) saveJson(exportFileName(org.slug, Date.now()), outcome.value);
    else setProblem(outcome.detail ?? outcome.message);
  };

  return (
    <div className={styles["row"]}>
      <h3 className={styles["rowTitle"]}>Download export</h3>
      <p className={styles["body"]}>
        A JSON file with the org, its settings, price overrides, account summaries, members, teams
        and service tokens. Secrets are cut to a preview and tokens are left out. Usage records are
        not in it. Take one before deleting the org: nothing can be restored afterwards.
      </p>
      <button type="button" className={kit["secondary"]} disabled={read.busy} onClick={download}>
        <Download aria-hidden="true" size={16} strokeWidth={2.25} />
        {read.busy ? "Preparing…" : "Download export"}
      </button>
      {problem === undefined ? null : (
        <p className={kit["fieldError"]} role="alert">
          {problem}
        </p>
      )}
    </div>
  );
};

const DeleteRow = ({ org, owner }: { readonly org: OrgView; readonly owner: boolean }) => {
  const remove = useAction(deleteOrgAtom);
  const [open, setOpen] = useState(false);

  const confirm = async (name: string) => {
    const outcome = await remove.run({ payload: { name } });

    if (outcome.ok) {
      window.location.assign("/");

      // The page is going away: stay busy until it does.
      return await new Promise<never>(() => undefined);
    }

    switch (outcome.error) {
      case "name_mismatch":
        return "That is not the org's name. Type it exactly as shown.";
      case "global_org":
        return "The first org cannot be deleted.";
      case "deletion_incomplete":
        return "The org still holds data. Press Delete org again to continue.";
      default:
        return outcome.detail ?? outcome.message;
    }
  };

  const explanation = (): string | undefined => {
    if (org.id === GLOBAL_ORG_ID)
      return "This is the first org of the deployment. It holds the deployment's own settings and cannot be deleted.";

    return owner ? undefined : "Only org owners can delete the org.";
  };

  return (
    <div className={styles["row"]}>
      <h3 className={styles["rowTitle"]}>Delete this org</h3>
      <p className={styles["body"]}>
        Deleting the org removes its usage records, accounts, provider keys, settings, members,
        proxy keys and sessions.{" "}
        <strong>
          It is immediate and permanent: there is no grace period and nothing can be restored.
        </strong>{" "}
        Download the export first.
      </p>
      {explanation() === undefined ? (
        <button type="button" className={kit["danger"]} onClick={() => setOpen(true)}>
          <Trash2 aria-hidden="true" size={16} strokeWidth={2.25} />
          Delete org
        </button>
      ) : (
        <p className={kit["muted"]}>{explanation()}</p>
      )}
      <TypedConfirm
        open={open}
        title={`Delete ${org.name}?`}
        label={`Type ${org.name} to confirm`}
        expected={org.name}
        action="Delete org"
        busyAction="Deleting…"
        onConfirm={confirm}
        onClose={() => setOpen(false)}
      >
        <p>
          This deletes <strong>{org.name}</strong> and everything in it at once. There is no grace
          period and no restore. Its address, /o/{org.slug}, becomes free to take again.
        </p>
        <p>If you may want any of it, download the export first.</p>
      </TypedConfirm>
    </div>
  );
};

/** The section's body: export for org admins (everyone who reaches the page), deletion for owners. */
export const DangerBody = () => {
  const result = useAtomValue(orgAtom);
  const retry = useAtomRefresh(orgAtom);
  const role = useRole();
  const owner = role.kind === "ready" && atLeast(role.caller.role, "owner");

  return AsyncResult.match(result, {
    onInitial: () => (
      <p className={kit["muted"]} aria-busy="true">
        Loading the org…
      </p>
    ),
    onFailure: (failure) => (
      <Problem onRetry={retry}>Could not load the org. {failureMessage(failure)}</Problem>
    ),
    onSuccess: ({ value }) => (
      <div className={styles["rows"]}>
        <ExportRow org={value} />
        <DeleteRow org={value} owner={owner} />
      </div>
    ),
  });
};
