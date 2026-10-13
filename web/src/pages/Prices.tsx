// Prices (/usage/prices): the org's price overrides, what a model costs per million tokens where the catalog has no
// price or the org pays another one. Each saved price costs the requests that come after it; a request keeps the
// cost it was recorded with. The Usage page's unpriced callout links here with the provider and model filled in.
// Edits are saved with the override's revision (`If-Match`); another edit that landed first is refused and the list
// reloads.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { ArrowLeft, Check, Pencil, Plus, X } from "lucide-react";
import { type FormEvent, useId, useRef, useEffect, useState } from "react";
import type { PriceOverride } from "#contract/prices.ts";
import { priceOverridesAtom, savePriceAtom } from "../api/client.ts";
import { kit, Problem } from "../components/Kit.tsx";
import { failureMessage } from "../lib/failure.ts";
import { formatRate } from "../lib/format.ts";
import {
  draftFor,
  draftOf,
  hasPriceErrors,
  KNOWN_PROVIDERS,
  overrideOf,
  type PriceDraft,
  type PriceField,
  priceBody,
  priceProblem,
  sortOverrides,
  validatePrice,
} from "../lib/prices.ts";
import { providerName } from "../lib/providers.ts";
import { useAction } from "../lib/use-action.ts";
import { usePageTitle } from "../lib/use-page-title.ts";
import styles from "./Prices.module.css";

/** What a save did, or why it failed, said under the table. */
type Note =
  | { readonly tone: "done"; readonly text: string }
  | { readonly tone: "problem"; readonly text: string; readonly stale: boolean };

const FIELDS: ReadonlyArray<{
  readonly field: PriceField;
  readonly label: string;
  readonly hint?: string;
}> = [
  { field: "input", label: "Input, per million tokens" },
  { field: "output", label: "Output, per million tokens" },
  { field: "cacheRead", label: "Cache read", hint: "Empty: the input price" },
  { field: "cacheWrite", label: "Cache write", hint: "Empty: the input price" },
];

/** Focus the first field a failed submit marked (the marks render first). */
const focusFirstInvalid = (form: HTMLFormElement) => {
  requestAnimationFrame(() => form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
};

const PriceForm = ({
  initial,
  editing,
  existing,
  busy,
  onSave,
  onCancel,
}: {
  readonly initial: PriceDraft;
  readonly editing: PriceOverride | undefined;
  readonly existing: ReadonlyArray<PriceOverride>;
  readonly busy: boolean;
  readonly onSave: (draft: PriceDraft) => Promise<boolean>;
  readonly onCancel: () => void;
}) => {
  const ids = useId();
  const [draft, setDraft] = useState(initial);
  const [tried, setTried] = useState(false);
  const errors = validatePrice(draft, existing, editing);
  const shown = tried ? errors : {};

  // A link that fills the model in sends the operator on to the prices.
  const first = useRef<HTMLInputElement>(null);
  const second = useRef<HTMLInputElement>(null);

  useEffect(() => {
    (initial.provider !== "" && initial.model !== "" ? second : first).current?.focus();
  }, [initial.provider, initial.model]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTried(true);

    if (hasPriceErrors(errors)) return focusFirstInvalid(event.currentTarget);

    if (await onSave(draft)) setTried(false);
  };

  const textField = (
    field: PriceField,
    label: string,
    options: {
      readonly ref?: React.RefObject<HTMLInputElement | null>;
      readonly list?: string;
      readonly hint?: string;
      readonly numeric?: boolean;
    } = {},
  ) => (
    <div className={kit["field"]} key={field}>
      <label className={kit["fieldLabel"]} htmlFor={`${ids}-${field}`}>
        {label}
      </label>
      <input
        ref={options.ref}
        id={`${ids}-${field}`}
        className={kit["input"]}
        spellCheck={false}
        autoComplete="off"
        inputMode={options.numeric === true ? "decimal" : undefined}
        {...(options.list === undefined ? {} : { list: options.list })}
        value={draft[field]}
        aria-invalid={shown[field] !== undefined}
        aria-describedby={`${ids}-${field}-note`}
        onChange={(event) => setDraft({ ...draft, [field]: event.target.value })}
      />
      <span
        id={`${ids}-${field}-note`}
        className={shown[field] === undefined ? styles["hint"] : kit["fieldError"]}
      >
        {shown[field] ?? options.hint ?? ""}
      </span>
    </div>
  );

  return (
    <form
      className={styles["form"]}
      onSubmit={submit}
      noValidate
      aria-label={editing === undefined ? "Add a price" : `Edit the price of ${editing.model}`}
    >
      <div className={styles["names"]}>
        {textField("provider", "Provider", { ref: first, list: `${ids}-providers` })}
        {textField("model", "Model", { ref: second })}
        <datalist id={`${ids}-providers`}>
          {KNOWN_PROVIDERS.map((provider) => (
            <option key={provider} value={provider} />
          ))}
        </datalist>
      </div>
      <div className={styles["rates"]}>
        {FIELDS.map(({ field, label, hint }) =>
          textField(field, label, { numeric: true, ...(hint === undefined ? {} : { hint }) }),
        )}
      </div>
      <div className={styles["formActions"]}>
        <button type="submit" className={kit["secondary"]} disabled={busy} aria-busy={busy}>
          {editing === undefined ? (
            <Plus aria-hidden="true" size={16} strokeWidth={2.25} />
          ) : (
            <Check aria-hidden="true" size={16} strokeWidth={2.25} />
          )}
          {busy ? "Saving…" : editing === undefined ? "Add price" : "Save price"}
        </button>
        <button type="button" className={styles["quiet"]} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
};

const optionalRate = (rate: number | undefined) =>
  rate === undefined ? <span className={kit["muted"]}>Input price</span> : formatRate(rate);

const PriceTable = ({
  overrides,
  busy,
  onEdit,
  onRemove,
}: {
  readonly overrides: ReadonlyArray<PriceOverride>;
  readonly busy: boolean;
  readonly onEdit: (override: PriceOverride) => void;
  readonly onRemove: (override: PriceOverride) => void;
}) => (
  <table className={styles["table"]}>
    <caption className={kit["visuallyHidden"]}>Prices in US dollars per million tokens</caption>
    <thead>
      <tr>
        <th scope="col">Model</th>
        <th scope="col" className={styles["number"]}>
          Input
        </th>
        <th scope="col" className={styles["number"]}>
          Output
        </th>
        <th scope="col" className={`${styles["number"]} ${styles["wide"]}`}>
          Cache read
        </th>
        <th scope="col" className={`${styles["number"]} ${styles["wide"]}`}>
          Cache write
        </th>
        <th scope="col">
          <span className={kit["visuallyHidden"]}>Actions</span>
        </th>
      </tr>
    </thead>
    <tbody>
      {overrides.map((override) => (
        <tr key={override.id}>
          <th scope="row" className={styles["name"]}>
            {override.model}
            <span className={styles["secondary"]}>{providerName(override.provider)}</span>
          </th>
          <td className={styles["number"]}>{formatRate(override.input)}</td>
          <td className={styles["number"]}>{formatRate(override.output)}</td>
          <td className={`${styles["number"]} ${styles["wide"]}`}>
            {optionalRate(override.cache_read)}
          </td>
          <td className={`${styles["number"]} ${styles["wide"]}`}>
            {optionalRate(override.cache_write)}
          </td>
          <td className={styles["actions"]}>
            <button
              type="button"
              className={styles["icon"]}
              aria-label={`Edit the price of ${override.model}`}
              title="Edit"
              onClick={() => onEdit(override)}
            >
              <Pencil aria-hidden="true" size={16} strokeWidth={2.25} />
            </button>
            <button
              type="button"
              className={styles["icon"]}
              aria-label={`Remove the price of ${override.model}`}
              title="Remove"
              disabled={busy}
              onClick={() => onRemove(override)}
            >
              <X aria-hidden="true" size={18} strokeWidth={2.25} />
            </button>
          </td>
        </tr>
      ))}
    </tbody>
  </table>
);

/** The form being shown: a new price (filled in from the address) or an override being edited. */
type Open =
  | { readonly kind: "new"; readonly draft: PriceDraft }
  | { readonly kind: "edit"; readonly override: PriceOverride };

const Prices = ({
  overrides,
  onReload,
}: {
  readonly overrides: ReadonlyArray<PriceOverride>;
  readonly onReload: () => void;
}) => {
  const search = useSearch({ from: "/usage/prices" });
  const navigate = useNavigate({ from: "/usage/prices" });
  const save = useAction(savePriceAtom);
  const sorted = sortOverrides(overrides);
  const [note, setNote] = useState<Note | undefined>(undefined);

  const [open, setOpen] = useState<Open | undefined>(() => {
    if (search.provider === undefined && search.model === undefined) return undefined;
    const draft = draftFor(search);

    // The pair has a price already: edit that one.
    const found = overrideOf(draft, overrides);

    return found === undefined ? { kind: "new", draft } : { kind: "edit", override: found };
  });

  const close = () => {
    setOpen(undefined);

    if (search.provider !== undefined || search.model !== undefined)
      void navigate({ search: {}, replace: true, resetScroll: false });
  };

  const run = async (write: Parameters<typeof save.run>[0], done: string): Promise<boolean> => {
    setNote(undefined);
    const outcome = await save.run(write);

    if (outcome.ok) {
      setNote({ tone: "done", text: done });

      return true;
    }

    setNote({
      tone: "problem",
      text: priceProblem(outcome.error, outcome.message),
      stale: outcome.error === "conflict",
    });

    return false;
  };

  return (
    <>
      {sorted.length === 0 ? (
        <p className={styles["empty"]}>
          No prices of your own yet. Models with a price in the catalog are costed from it; add a
          price for one that has none, or to charge another rate.
        </p>
      ) : (
        <PriceTable
          overrides={sorted}
          busy={save.busy}
          onEdit={(override) => {
            setNote(undefined);
            setOpen({ kind: "edit", override });
          }}
          onRemove={(override) =>
            void run(
              { kind: "remove", id: override.id, revision: override.revision },
              `Removed the price of ${override.model}.`,
            )
          }
        />
      )}
      {open === undefined ? (
        <div className={styles["foot"]}>
          <button
            type="button"
            className={kit["secondary"]}
            onClick={() => {
              setNote(undefined);
              setOpen({ kind: "new", draft: draftFor({}) });
            }}
          >
            <Plus aria-hidden="true" size={16} strokeWidth={2.25} />
            Add a price
          </button>
        </div>
      ) : (
        <PriceForm
          key={open.kind === "edit" ? open.override.id : "new"}
          initial={open.kind === "edit" ? draftOf(open.override) : open.draft}
          editing={open.kind === "edit" ? open.override : undefined}
          existing={overrides}
          busy={save.busy}
          onCancel={close}
          onSave={async (draft) => {
            const body = priceBody(draft);

            const saved =
              open.kind === "edit"
                ? await run(
                    {
                      kind: "replace",
                      id: open.override.id,
                      revision: open.override.revision,
                      body,
                    },
                    `Saved the price of ${body.model}.`,
                  )
                : await run({ kind: "create", body }, `Added a price for ${body.model}.`);

            if (saved) close();

            return saved;
          }}
        />
      )}
      {note?.tone === "problem" ? (
        <Problem {...(note.stale ? { onRetry: onReload, retryLabel: "Reload" } : {})}>
          Could not save. {note.text}
        </Problem>
      ) : null}
      <p className={styles["note"]} role="status">
        {note?.tone === "done" ? note.text : null}
      </p>
    </>
  );
};

export const PricesPage = () => {
  usePageTitle("Prices · Usage");
  const result = useAtomValue(priceOverridesAtom);
  const retry = useAtomRefresh(priceOverridesAtom);

  return (
    <div className={styles["page"]}>
      <header className={styles["head"]}>
        <Link to="/usage" className={styles["back"]}>
          <ArrowLeft aria-hidden="true" size={16} strokeWidth={2.25} />
          Usage
        </Link>
        <h1 className={styles["title"]}>Prices</h1>
        <p className={styles["intro"]}>
          The cost of a request is its tokens times the model&rsquo;s price, kept when the request
          is recorded. Prices here are in US dollars per million tokens and win over the
          catalog&rsquo;s. A new or changed price costs the requests that come after it; earlier
          requests keep the cost they were recorded with. A provider is the key of its accounts (
          <code>codex</code>, <code>claude</code>, …) and a model is named as it appears in the{" "}
          <Link to="/usage">usage log</Link>.
        </p>
      </header>
      {AsyncResult.match(result, {
        onInitial: () => (
          <p className={kit["muted"]} aria-busy="true">
            Loading the prices…
          </p>
        ),
        onFailure: (failure) => (
          <Problem onRetry={retry}>Could not load the prices. {failureMessage(failure)}</Problem>
        ),
        onSuccess: ({ value }) => <Prices overrides={value.overrides} onReload={retry} />,
      })}
    </div>
  );
};
