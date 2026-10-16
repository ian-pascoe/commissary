// My models (/my-models): the models the signed-in member may use, as their grants leave them (ADR 0023). Every member
// reads it; an org admin reads their own list here, the org's whole registry is on the Models page.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useDeferredValue, useId, useState } from "react";
import type { MyModel } from "@commissary/contract/grants";
import { myModelsAtom } from "../api/client.ts";
import { kit, Problem } from "../components/Kit.tsx";
import { failureMessage } from "../lib/failure.ts";
import { formatCount } from "../lib/format.ts";
import { filterMyModels, modelsNote } from "../lib/grants.ts";
import { usePageTitle } from "../lib/use-page-title.ts";
import styles from "./MyModels.module.css";

const ModelTable = ({ models }: { readonly models: ReadonlyArray<MyModel> }) => (
  <table className={styles["table"]}>
    <caption className={kit["visuallyHidden"]}>Models you may use</caption>
    <thead>
      <tr>
        <th scope="col">Model</th>
        <th scope="col" className={styles["wide"]}>
          Type
        </th>
        <th scope="col" className={styles["wide"]}>
          Owned by
        </th>
      </tr>
    </thead>
    <tbody>
      {models.map((model) => (
        <tr key={model.id}>
          <th scope="row" className={styles["name"]}>
            <code>{model.id}</code>
            {model.display_name === undefined ? null : (
              <span className={styles["secondary"]}>{model.display_name}</span>
            )}
          </th>
          <td className={styles["wide"]}>{model.type}</td>
          <td className={styles["wide"]}>{model.owned_by}</td>
        </tr>
      ))}
    </tbody>
  </table>
);

const Models = ({ models }: { readonly models: ReadonlyArray<MyModel> }) => {
  const id = useId();
  const [query, setQuery] = useState("");
  const shown = filterMyModels(models, useDeferredValue(query));

  if (models.length === 0) return <p className={styles["empty"]}>{modelsNote(0)}</p>;

  return (
    <>
      <div className={kit["field"]}>
        <label className={kit["fieldLabel"]} htmlFor={id}>
          Find a model
        </label>
        <input
          id={id}
          className={kit["input"]}
          type="search"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <p className={styles["count"]} role="status">
        {formatCount(shown.length)} of {formatCount(models.length)} models
      </p>
      {shown.length === 0 ? (
        <p className={styles["empty"]}>No model matches &ldquo;{query.trim()}&rdquo;.</p>
      ) : (
        <ModelTable models={shown} />
      )}
    </>
  );
};

export const MyModelsPage = () => {
  usePageTitle("My models");
  const result = useAtomValue(myModelsAtom);
  const retry = useAtomRefresh(myModelsAtom);

  return (
    <div className={styles["page"]}>
      <header className={styles["head"]}>
        <h1 className={styles["title"]}>My models</h1>
        <p className={styles["intro"]}>
          The models you may use, as your org&rsquo;s grants leave them: the ones given to you, to a
          team you are on and to everyone. A model that is not listed here answers as unknown. Your
          own private accounts are always yours and add their models.
        </p>
      </header>
      {AsyncResult.match(result, {
        onInitial: () => (
          <p className={kit["muted"]} aria-busy="true">
            Loading your models…
          </p>
        ),
        onFailure: (failure) => (
          <Problem onRetry={retry}>Could not load your models. {failureMessage(failure)}</Problem>
        ),
        onSuccess: ({ value }) => <Models models={value.models} />,
      })}
    </div>
  );
};
