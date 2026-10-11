// One Settings section as its own form: a draft of the inputs the operator touched, Save / Discard while it differs
// from the view ("2 changes"), and the outcome. The draft is a delta (`lib/settings.ts`): when the view refreshes
// (this or another section saved, or a reload) it rebases, keeping changes whose field did not move on the server and
// listing the ones that did. A save sends only the changed leaves with the view's version; on 409 it is re-applied
// once to a fresh read (`saveDraft`), and a 422 lands under the field the server names, which takes the focus. Every
// other outcome (a field changed elsewhere, a failed save, nothing to save) shows in the sticky actions bar, above the
// buttons that caused it. The section reports its change count up (`onChanges`) for the jump list and leave guard.
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import type { SettingsView } from "#contract/settings.ts";
import { saveSettingsAtom } from "../api/client.ts";
import { kit, Problem } from "../components/Kit.tsx";
import {
  changedFields,
  draftErrors,
  type Edits,
  type FieldSpec,
  fieldId,
  fieldOfPath,
  fieldSpec,
  type Input,
  inputOf,
  isDefault,
  rebaseDraft,
  type SectionId,
  saveProblem,
  shownInput,
  valueAt,
  valueText,
} from "../lib/settings.ts";
import { useAction } from "../lib/use-action.ts";
import { type FieldProps, SettingField } from "./SettingsControls.tsx";
import { copyOf } from "./SettingsCopy.ts";
import styles from "./Settings.module.css";

/** How long the section head says "Saved". */
const SAVED_FOR_MS = 6000;

/** What a section's body renders its settings with. */
export interface Fields {
  /** The setting at `path`, with its draft input, error, default caption and reset. */
  readonly field: (
    path: string,
    options?: Pick<FieldProps, "disabled" | "extra" | "requires">,
  ) => ReactNode;
  /** The input a setting shows now (for dependencies such as the session binding). */
  readonly input: (path: string) => Input | undefined;
}

type Notice =
  | { readonly kind: "problem"; readonly text: string; readonly stale: boolean }
  | { readonly kind: "unchanged" };

const union = (
  a: ReadonlyArray<FieldSpec>,
  b: ReadonlyArray<FieldSpec>,
): ReadonlyArray<FieldSpec> => [
  ...a,
  ...b.filter((spec) => !a.some((known) => known.path === spec.path)),
];

const sentence = (text: string): string =>
  `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? "" : "."}`;

/** A field's current server value in a few words, by its choice's name when it has one. */
const nowText = (spec: FieldSpec, view: SettingsView): string => {
  const value = valueAt(view.values, spec.path);
  const input = inputOf(spec, value);

  const option = copyOf(spec.path, spec.label).options?.find(
    (candidate) => candidate.value === input,
  );

  return option === undefined ? valueText(spec, value) : option.name.toLowerCase();
};

const changes = (count: number): string => `${count} ${count === 1 ? "change" : "changes"}`;

/** Focus a control and bring it to the middle of the screen, well clear of the sticky actions bar. */
const focusClear = (element: HTMLElement | null | undefined) => {
  if (element === null || element === undefined) return;
  element.focus({ preventScroll: true });
  element.scrollIntoView({ block: "center" });
};

/** Focus the first field the failed submit marked (the marks render first). */
const focusFirstInvalid = (form: HTMLFormElement) => {
  requestAnimationFrame(() => focusClear(form.querySelector<HTMLElement>('[aria-invalid="true"]')));
};

const focusField = (path: string) => {
  requestAnimationFrame(() => focusClear(document.getElementById(fieldId(path))));
};

export const SettingsSection = ({
  id,
  title,
  view,
  onReload,
  onChanges,
  lead,
  children,
}: {
  readonly id: SectionId;
  readonly title: string;
  readonly view: SettingsView;
  readonly onReload: () => void;
  /** The section's number of unsaved changes, whenever it changes (0 when it goes away). */
  readonly onChanges: (id: SectionId, count: number) => void;
  readonly lead?: ReactNode;
  readonly children: (fields: Fields) => ReactNode;
}) => {
  const save = useAction(saveSettingsAtom(id));
  const [edits, setEdits] = useState<Edits>({});
  const [base, setBase] = useState(view);
  const [conflicts, setConflicts] = useState<ReadonlyArray<FieldSpec>>([]);
  const [serverErrors, setServerErrors] = useState<Readonly<Record<string, string>>>({});
  const [tried, setTried] = useState(false);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  /** The version a save wrote, until the view shows it. */
  const [pending, setPending] = useState<number | undefined>(undefined);
  const [saved, setSaved] = useState(false);

  // A newer view: rebase the draft onto it (derived state, set while rendering).
  if (base !== view) {
    const rebased = rebaseDraft(edits, base.values, view.values);

    setEdits(rebased.edits);
    setBase(view);
    setConflicts(
      union(
        conflicts.filter((spec) => rebased.edits[spec.path] !== undefined),
        rebased.moved,
      ),
    );
  }

  if (pending !== undefined && view.version >= pending) {
    setPending(undefined);
    setSaved(true);
  }

  // The Save button goes away with the draft: keep the keyboard in the section.
  useEffect(() => {
    if (saved && document.activeElement === document.body)
      document.getElementById(`${id}-title`)?.focus();
  }, [saved, id]);

  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), SAVED_FOR_MS);

    return () => clearTimeout(timer);
  }, [saved]);

  // "Nothing to save" is news only for a moment, like "Saved".
  useEffect(() => {
    if (notice?.kind !== "unchanged") return;
    const timer = setTimeout(() => setNotice(undefined), SAVED_FOR_MS);

    return () => clearTimeout(timer);
  }, [notice]);

  const values = view.values;
  const changed = changedFields(edits, values);
  const count = changed.length;

  useEffect(() => onChanges(id, count), [onChanges, id, count]);
  useEffect(() => () => onChanges(id, 0), [onChanges, id]);
  const errors = { ...(tried ? draftErrors(edits, values) : {}), ...serverErrors };
  const busy = save.busy || pending !== undefined;

  const set = (path: string, input: Input) => {
    setEdits({ ...edits, [path]: input });
    setSaved(false);
    setNotice(undefined);

    if (serverErrors[path] !== undefined)
      setServerErrors(
        Object.fromEntries(Object.entries(serverErrors).filter(([known]) => known !== path)),
      );
  };

  const discard = () => {
    setEdits({});
    setConflicts([]);
    setServerErrors({});
    setTried(false);
    setNotice(undefined);
  };

  /** Take the server's values for the fields that moved, keep the rest of the draft, and refresh. */
  const takeTheirs = () => {
    setEdits(
      Object.fromEntries(
        Object.entries(edits).filter(([path]) => !conflicts.some((spec) => spec.path === path)),
      ),
    );
    setConflicts([]);
    setNotice(undefined);
    onReload();
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;

    setTried(true);
    setNotice(undefined);
    setServerErrors({});

    if (Object.keys(draftErrors(edits, values)).length > 0) return focusFirstInvalid(form);
    const outcome = await save.run({ edits, base: view });

    if (outcome.ok) {
      setTried(false);
      const result = outcome.value;

      if (result.kind === "saved") {
        setConflicts([]);
        setPending(result.version);
      } else if (result.kind === "moved") setConflicts(union(conflicts, result.fields));
      else {
        setEdits({});
        setNotice({ kind: "unchanged" });
      }

      return;
    }

    const spec = fieldOfPath(outcome.path);

    if (
      spec !== undefined &&
      (outcome.error === "invalid_setting" || outcome.error === "would_remove_your_admin_access")
    ) {
      setServerErrors({
        [spec.path]:
          outcome.error === "invalid_setting"
            ? sentence(outcome.detail ?? outcome.message)
            : saveProblem(outcome.error, outcome.message),
      });

      return focusField(spec.path);
    }

    setNotice({
      kind: "problem",
      text: saveProblem(outcome.error, outcome.detail ?? outcome.message),
      stale: outcome.error === "conflict",
    });
  };

  const fields: Fields = {
    field: (path, options) => {
      const spec = fieldSpec(path);

      if (spec === undefined) return null;

      return (
        <SettingField
          key={path}
          spec={spec}
          input={shownInput(spec, edits, values)}
          error={errors[path]}
          isDefault={isDefault(spec, edits, values, view.defaults)}
          {...options}
          onChange={(input) => set(path, input)}
          onReset={() => set(path, inputOf(spec, valueAt(view.defaults, path)))}
        />
      );
    },
    input: (path) => {
      const spec = fieldSpec(path);

      return spec === undefined ? undefined : shownInput(spec, edits, values);
    },
  };

  const state =
    count > 0 ? changes(count) : saved ? "Saved. Takes effect within a few seconds." : "";

  return (
    <section id={id} className={styles["section"]} aria-labelledby={`${id}-title`}>
      <form noValidate onSubmit={submit} aria-labelledby={`${id}-title`}>
        <header className={styles["sectionHead"]}>
          <h2 id={`${id}-title`} className={styles["sectionTitle"]} tabIndex={-1}>
            {title}
          </h2>
          <span className={styles["state"]} role="status">
            {state}
          </span>
        </header>
        {lead}
        <div className={styles["fields"]}>{children(fields)}</div>
        {count === 0 && notice === undefined && conflicts.length === 0 ? null : (
          <div className={styles["actions"]}>
            {conflicts.length === 0 ? null : (
              <Problem>
                Changed elsewhere:{" "}
                {conflicts.map((spec) => `${spec.label} (now ${nowText(spec, view)})`).join(", ")}.
                Save keeps yours; Reload takes {conflicts.length === 1 ? "that value" : "those"}.
              </Problem>
            )}
            {notice?.kind === "problem" ? <Problem>Could not save. {notice.text}</Problem> : null}
            {notice?.kind === "unchanged" ? (
              <p className={styles["quiet"]} role="status">
                The configuration already said so; nothing to save.
              </p>
            ) : null}
            {count === 0 ? null : (
              <div className={styles["buttons"]}>
                <button type="submit" className={kit["primary"]} disabled={busy}>
                  {busy ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  className={kit["secondary"]}
                  disabled={busy}
                  onClick={discard}
                >
                  Discard
                </button>
                {conflicts.length > 0 || (notice?.kind === "problem" && notice.stale) ? (
                  <button
                    type="button"
                    className={kit["secondary"]}
                    disabled={busy}
                    onClick={conflicts.length > 0 ? takeTheirs : onReload}
                  >
                    Reload
                  </button>
                ) : null}
              </div>
            )}
          </div>
        )}
      </form>
    </section>
  );
};
