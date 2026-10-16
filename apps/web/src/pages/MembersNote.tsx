// What a Members page write did, said under its section: a line for success, the red problem for a refusal.
import { useState } from "react";
import { Problem } from "../components/Kit.tsx";
import { memberProblem } from "../lib/members.ts";
import type { Outcome } from "../lib/use-action.ts";
import styles from "./Members.module.css";

type Note =
  | { readonly tone: "done"; readonly text: string }
  | { readonly tone: "problem"; readonly text: string };

/** One section's last result. `settle` reports a write's outcome and says whether it succeeded. */
export const useNote = () => {
  const [note, setNote] = useState<Note | undefined>(undefined);

  const settle = <A,>(outcome: Outcome<A>, done: string): boolean => {
    setNote(
      outcome.ok
        ? { tone: "done", text: done }
        : { tone: "problem", text: memberProblem(outcome.error, outcome.message, outcome.detail) },
    );

    return outcome.ok;
  };

  return { note, settle, clear: () => setNote(undefined) } as const;
};

export type NoteState = ReturnType<typeof useNote>["note"];

/** A live region: it stays mounted so a result is announced, taking no room while it is empty. */
export const NoteLine = ({ note }: { readonly note: NoteState }) => (
  <>
    {note?.tone === "problem" ? <Problem>Could not save. {note.text}</Problem> : null}
    <p className={styles["note"]} role="status">
      {note?.tone === "done" ? note.text : null}
    </p>
  </>
);
