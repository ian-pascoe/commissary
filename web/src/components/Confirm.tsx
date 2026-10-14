// A confirmation before something that cannot be undone: a native modal <dialog> that opens while a request is set.
import { ShieldCheck, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef } from "react";
import { kit } from "./Kit.tsx";

/** What is being confirmed: the question, what happens, the confirming button's words and what it runs. */
export interface ConfirmRequest {
  readonly title: string;
  readonly body: ReactNode;
  readonly action: string;
  readonly busyAction: string;
  /**
   * `danger` (the default) is for deleting. `primary` confirms a change that is not a deletion but ends something
   * (sessions), with the cancel button saying `keep`.
   */
  readonly tone?: "danger" | "primary";
  /** The words of the cancelling button ("Keep it"). */
  readonly keep?: string;
  /** Runs the change; the dialog stays open, saying so, until it settles. */
  readonly run: () => Promise<void>;
}

export const ConfirmDialog = ({
  request,
  busy,
  onClose,
}: {
  readonly request: ConfirmRequest | undefined;
  readonly busy: boolean;
  readonly onClose: () => void;
}) => {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const element = dialog.current;

    if (element === null) return;

    if (request !== undefined && !element.open) element.showModal();
    else if (request === undefined && element.open) element.close();
  }, [request]);

  return (
    <dialog ref={dialog} className={kit["dialog"]} aria-labelledby={titleId} onClose={onClose}>
      {request === undefined ? null : (
        <form
          method="dialog"
          className={kit["dialogBody"]}
          onSubmit={async (event) => {
            event.preventDefault();
            await request.run();
            onClose();
          }}
        >
          <h2 id={titleId} className={kit["dialogTitle"]}>
            {request.title}
          </h2>
          <div>{request.body}</div>
          <div className={kit["dialogActions"]}>
            <button
              type="submit"
              className={request.tone === "primary" ? kit["primary"] : kit["danger"]}
              disabled={busy}
              aria-busy={busy}
            >
              {request.tone === "primary" ? (
                <ShieldCheck aria-hidden="true" size={16} strokeWidth={2.25} />
              ) : (
                <Trash2 aria-hidden="true" size={16} strokeWidth={2.25} />
              )}
              {busy ? request.busyAction : request.action}
            </button>
            <button type="button" className={kit["secondary"]} disabled={busy} onClick={onClose}>
              {request.keep ?? "Keep it"}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
};
