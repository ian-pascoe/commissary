// A value the operator copies into another system (a redirect address, a DNS record): its label, the value in a
// read-only field that selects itself on focus, and a Copy button that says what happened.
import { Check, Copy } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { kit } from "./Kit.tsx";
import styles from "./CopyValue.module.css";

type CopyState = "idle" | "copied" | "failed";

export const CopyValue = ({ label, value }: { readonly label: string; readonly value: string }) => {
  const id = useId();
  const [copy, setCopy] = useState<CopyState>("idle");

  // "Copied" is for a moment: the next value copied says so again.
  useEffect(() => {
    if (copy !== "copied") return;
    const timer = setTimeout(() => setCopy("idle"), 2500);

    return () => clearTimeout(timer);
  }, [copy]);

  return (
    <div className={styles["copy"]}>
      <label className={kit["fieldLabel"]} htmlFor={id}>
        {label}
      </label>
      <div className={styles["row"]}>
        <input
          id={id}
          className={`${kit["input"]} ${styles["value"]}`}
          readOnly
          spellCheck={false}
          autoComplete="off"
          value={value}
          onFocus={(event) => event.currentTarget.select()}
        />
        <button
          type="button"
          className={kit["secondary"]}
          aria-label={`Copy ${label}`}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopy("copied");
            } catch {
              setCopy("failed");
            }
          }}
        >
          {copy === "copied" ? (
            <Check aria-hidden="true" size={16} strokeWidth={2.5} />
          ) : (
            <Copy aria-hidden="true" size={16} strokeWidth={2.25} />
          )}
          {copy === "copied" ? "Copied" : "Copy"}
        </button>
      </div>
      <p className={styles["note"]} role="status">
        {copy === "failed" ? "The browser refused the copy. Select the text and copy it." : null}
      </p>
    </div>
  );
};
