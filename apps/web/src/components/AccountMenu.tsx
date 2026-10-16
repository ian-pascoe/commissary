// The shell's account menu, the theme menu's twin on the bar: sign out (Commissary Cloud only; a self-hosted panel has no
// session of its own, Cloudflare Access holds it) and delete my account (ADR 0027), which asks in a dialog first.
import { CircleUserRound, Trash2 } from "lucide-react";
import { useState } from "react";
import { useMenuButton } from "../lib/use-menu-button.ts";
import styles from "./BarMenu.module.css";
import { DeleteAccount } from "./DeleteAccount.tsx";
import { SignOut } from "./SignOut.tsx";

/**
 * `hosted`: Commissary is hosted, so Sign out is offered. `offersDelete`: the panel knows the caller's role, so Delete my
 * account is offered.
 */
export const AccountMenu = ({
  hosted,
  offersDelete,
}: {
  readonly hosted: boolean;
  readonly offersDelete: boolean;
}) => {
  const menu = useMenuButton();
  const [deleting, setDeleting] = useState(false);

  if (!hosted && !offersDelete) return null;

  return (
    <div ref={menu.root} className={styles["root"]}>
      <button
        type="button"
        className={styles["button"]}
        aria-label="Account"
        title="Account"
        {...menu.buttonProps}
      >
        <CircleUserRound aria-hidden="true" size={18} strokeWidth={2.25} />
      </button>
      <div aria-label="Account" className={styles["menu"]} {...menu.menuProps}>
        <p className={styles["caption"]} aria-hidden="true">
          Account
        </p>
        {hosted ? <SignOut ref={menu.item(0)} role="menuitem" className={styles["item"]} /> : null}
        {offersDelete ? (
          <button
            ref={menu.item(1)}
            type="button"
            role="menuitem"
            tabIndex={-1}
            className={`${styles["item"]} ${styles["danger"]}`}
            onClick={() => {
              // Focus goes back to the menu button first, so the dialog returns it there when it closes.
              menu.close();
              setDeleting(true);
            }}
          >
            <Trash2 aria-hidden="true" size={16} strokeWidth={2.25} />
            Delete my account
          </button>
        ) : null}
      </div>
      {offersDelete ? <DeleteAccount open={deleting} onClose={() => setDeleting(false)} /> : null}
    </div>
  );
};
