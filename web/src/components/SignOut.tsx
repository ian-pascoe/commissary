// Ends the session of a hosted proxy and goes to the sign-in page. Rendered only where `me.hosted` is true.
import { LogOut } from "lucide-react";
import { useState } from "react";
import { AUTH_ROUTES, SIGN_IN_PAGE_PATH } from "#contract/sign-in.ts";

export const SignOut = ({ className }: { readonly className?: string | undefined }) => {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const signOut = async () => {
    setBusy(true);
    setFailed(false);

    try {
      const response = await fetch(AUTH_ROUTES.signOut, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: "{}",
      });

      if (response.ok) {
        window.location.assign(SIGN_IN_PAGE_PATH);

        return;
      }
    } catch {
      // The failure is reported below, like a refusal.
    }

    setFailed(true);
    setBusy(false);
  };

  return (
    <button
      type="button"
      className={className}
      disabled={busy}
      aria-busy={busy}
      title={failed ? "Sign-out failed. Try again." : "Sign out"}
      onClick={signOut}
    >
      <LogOut aria-hidden="true" size={16} strokeWidth={2.25} />
      <span>{failed ? "Try sign out again" : "Sign out"}</span>
    </button>
  );
};
