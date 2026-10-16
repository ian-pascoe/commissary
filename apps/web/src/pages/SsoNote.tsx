// What a single sign-on write did, said under its section: a line for success, the red problem for a refusal.
import { useState } from "react";
import { Problem } from "../components/Kit.tsx";
import { ssoProblem } from "../lib/sso.ts";
import type { Outcome } from "../lib/use-action.ts";
import styles from "./Sso.module.css";

type Note =
  | { readonly tone: "done"; readonly text: string }
  | { readonly tone: "problem"; readonly text: string };

/** One section's last result. `settle` reports an outcome and says whether it succeeded. */
export const useSsoNote = () => {
  const [note, setNote] = useState<Note | undefined>(undefined);

  const settle = <A,>(outcome: Outcome<A>, done: string): boolean => {
    setNote(
      outcome.ok
        ? { tone: "done", text: done }
        : { tone: "problem", text: ssoProblem(outcome.error, outcome.message, outcome.detail) },
    );

    return outcome.ok;
  };

  return { note, settle, clear: () => setNote(undefined) } as const;
};

export type NoteState = ReturnType<typeof useSsoNote>["note"];

/** A live region: it stays mounted so a result is announced, taking no room while it is empty. */
export const SsoNoteLine = ({ note }: { readonly note: NoteState }) => (
  <>
    {note?.tone === "problem" ? <Problem>{note.text}</Problem> : null}
    <p className={styles["note"]} role="status">
      {note?.tone === "done" ? note.text : null}
    </p>
  </>
);
