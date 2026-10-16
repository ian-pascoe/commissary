// A confirmation for something that cannot be undone and asks to be typed out: a native modal <dialog> with a text
// field. With `expected` the action stays off until the text matches it exactly; without, any text will do and the
// server checks it. The dialog stays open, saying so, until the request settles; a refusal is shown in it.
import { Trash2 } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { kit } from "./Kit.tsx";

export interface TypedConfirmProps {
  readonly open: boolean;
  readonly title: string;
  readonly children: ReactNode;
  /** What to type ("Org name"). */
  readonly label: string;
  /** The text that confirms; without it any non-empty text does. */
  readonly expected?: string;
  readonly action: string;
  readonly busyAction: string;
  /** Runs the change with the typed text: `undefined` when it worked, otherwise what to tell the operator. */
  readonly onConfirm: (typed: string) => Promise<ReactNode | undefined>;
  readonly onClose: () => void;
}

const TypedForm = ({
  title,
  titleId,
  children,
  label,
  expected,
  action,
  busyAction,
  onConfirm,
  onClose,
}: Omit<TypedConfirmProps, "open"> & { readonly titleId: string }) => {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ReactNode>(undefined);
  const inputId = useId();
  const confirmed = expected === undefined ? typed.trim() !== "" : typed === expected;

  const submit = async (event: FormEvent) => {
    event.preventDefault();

    if (!confirmed || busy) return;
    setBusy(true);
    setProblem(undefined);
    const failure = await onConfirm(typed);

    setBusy(false);

    if (failure === undefined) onClose();
    else setProblem(failure);
  };

  return (
    <form method="dialog" className={kit["dialogBody"]} onSubmit={submit}>
      <h2 id={titleId} className={kit["dialogTitle"]}>
        {title}
      </h2>
      <div>{children}</div>
      <label className={kit["field"]} htmlFor={inputId}>
        <span className={kit["fieldLabel"]}>{label}</span>
        <input
          id={inputId}
          className={kit["input"]}
          value={typed}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          disabled={busy}
          aria-invalid={problem !== undefined}
          onChange={(event) => setTyped(event.target.value)}
        />
      </label>
      {problem === undefined ? null : (
        <div className={kit["fieldError"]} role="alert">
          {problem}
        </div>
      )}
      <div className={kit["dialogActions"]}>
        <button
          type="submit"
          className={kit["danger"]}
          disabled={!confirmed || busy}
          aria-busy={busy}
        >
          <Trash2 aria-hidden="true" size={16} strokeWidth={2.25} />
          {busy ? busyAction : action}
        </button>
        <button type="button" className={kit["secondary"]} disabled={busy} onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
};

export const TypedConfirm = ({ open, onClose, ...form }: TypedConfirmProps) => {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const element = dialog.current;

    if (element === null) return;

    if (open && !element.open) element.showModal();
    else if (!open && element.open) element.close();
  }, [open]);

  return (
    <dialog ref={dialog} className={kit["dialog"]} aria-labelledby={titleId} onClose={onClose}>
      {/* Mounted only while open, so every opening starts with an empty field. */}
      {open ? <TypedForm {...form} titleId={titleId} onClose={onClose} /> : null}
    </dialog>
  );
};
