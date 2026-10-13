// Whose a new account or API key will be (ADR 0023). A plain member's is always private: only their own requests use
// it. An org admin chooses, where the org lets members connect private credentials; a shared one serves everyone.
import { useId } from "react";
import { type Caller, holdsOnlyPrivate } from "../lib/role.ts";
import { kit } from "./Kit.tsx";
import styles from "./Ownership.module.css";

/** Whether what the caller adds is private: always for a plain member, by choice for an org admin where allowed. */
export const addsPrivately = (caller: Caller | undefined, chosen: boolean): boolean =>
  caller !== undefined && (holdsOnlyPrivate(caller) || (caller.privateCredentials && chosen));

export const Ownership = ({
  caller,
  noun,
  chosen,
  onChange,
}: {
  readonly caller: Caller | undefined;
  /** What is being added: "account" or "API key". */
  readonly noun: string;
  readonly chosen: boolean;
  readonly onChange: (chosen: boolean) => void;
}) => {
  const id = useId();

  if (caller === undefined) return null;

  if (holdsOnlyPrivate(caller)) {
    return (
      <p className={styles["ownership"]}>
        This {noun} will be private to you: only your own requests use it. Org admins see that it
        exists, its provider and its label, and nothing more.
      </p>
    );
  }

  if (!caller.privateCredentials) {
    return (
      <p className={styles["ownership"]}>
        This {noun} will be shared: it answers requests from everyone in the org.
      </p>
    );
  }

  return (
    <div className={styles["ownership"]}>
      <label htmlFor={id} className={styles["choice"]}>
        <input
          id={id}
          type="checkbox"
          checked={chosen}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>Keep this {noun} private to me</span>
      </label>
      <p className={kit["muted"]}>
        {chosen
          ? "Only your own requests use it. Other org admins see that it exists, its provider and its label, and nothing more."
          : "Shared: it answers requests from everyone in the org."}
      </p>
    </div>
  );
};
