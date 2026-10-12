// The Models page's catalog line: when the model catalog was last refreshed and from where, and "Refresh catalog",
// which asks the server to download it now (the operation the 3-hourly task runs). The button is off, with the reason
// beside it, while the catalog source setting means nothing is fetched. The outcome is said inline; a refresh that
// fails or finds nothing new leaves the catalog in use as it was.
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { RefreshCw } from "lucide-react";
import { useId, useState } from "react";
import type { CatalogStatus } from "#contract/catalog.ts";
import { CATALOG, catalogStatusAtom, nowAtom, refreshCatalogAtom, ROUTING } from "../api/client.ts";
import { kit } from "../components/Kit.tsx";
import {
  catalogLine,
  catalogProblem,
  refreshHint,
  type RefreshNote,
  refreshNote,
} from "../lib/catalog.ts";
import { useAction } from "../lib/use-action.ts";
import styles from "./ModelsCatalog.module.css";

const CatalogBar = ({ status }: { readonly status: CatalogStatus }) => {
  const now = useAtomValue(nowAtom);
  const refresh = useAction(refreshCatalogAtom);
  const [note, setNote] = useState<RefreshNote | undefined>(undefined);
  const hintId = useId();
  const hint = refreshHint(status);
  const problem = catalogProblem(status);

  return (
    <section className={styles["catalog"]} aria-label="Model catalog">
      <div className={styles["said"]}>
        <p className={styles["line"]}>{catalogLine(status, now)}</p>
        {problem === undefined ? null : <p className={styles["problem"]}>{problem}</p>}
        {hint === undefined ? null : (
          <p id={hintId} className={styles["hint"]}>
            {hint}
          </p>
        )}
        <p className={styles["note"]} role="status" data-tone={note?.tone}>
          {note?.text}
        </p>
      </div>
      <button
        type="button"
        className={kit["secondary"]}
        disabled={hint !== undefined || refresh.busy}
        aria-busy={refresh.busy}
        aria-describedby={hint === undefined ? undefined : hintId}
        onClick={async () => {
          setNote(undefined);

          const outcome = await refresh.run({ reactivityKeys: [...CATALOG, ...ROUTING] });

          setNote(refreshNote(outcome));
        }}
      >
        <RefreshCw
          aria-hidden="true"
          size={16}
          strokeWidth={2.25}
          className={refresh.busy ? kit["spinning"] : undefined}
        />
        {refresh.busy ? "Refreshing…" : "Refresh catalog"}
      </button>
    </section>
  );
};

/** Nothing while the status loads or when it cannot be read: the catalog line is a convenience, not the page. */
export const ModelsCatalog = () => {
  const result = useAtomValue(catalogStatusAtom);

  return AsyncResult.match(result, {
    onInitial: () => null,
    onFailure: () => null,
    onSuccess: ({ value }) => <CatalogBar status={value} />,
  });
};
