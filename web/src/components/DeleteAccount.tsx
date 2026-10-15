// "Delete my account", from the shell's account menu (ADR 0027): the caller leaves every org they belong to with all they
// hold there, and an org they are alone in is deleted. They type their own email; the answer `409 sole_owner` lists the
// orgs they must hand over first. A service token cannot do it (403 `person_required`; `/me` does not say who the
// caller is), so the refusal is shown instead. A hard reload at the panel root afterwards.
import { deleteAccountAtom } from "../api/client.ts";
import { orgPanelPath } from "../lib/org.ts";
import { useAction } from "../lib/use-action.ts";
import styles from "./DeleteAccount.module.css";
import { TypedConfirm } from "./TypedConfirm.tsx";

/** The orgs the caller is the only owner of while others belong to them: what to do before the account can go. */
const HandOver = ({ slugs }: { readonly slugs: ReadonlyArray<string> }) => {
  const one = slugs.length === 1;

  return (
    <>
      You are the only owner of {one ? "this org" : "these orgs"}, and others belong to{" "}
      {one ? "it" : "them"}. Hand {one ? "it" : "them"} over first: make someone else an owner on
      the Members page.
      <ul className={styles["orgs"]}>
        {slugs.map((slug) => (
          <li key={slug}>
            <a href={orgPanelPath(slug, "/members")}>{slug}</a>
          </li>
        ))}
      </ul>
    </>
  );
};

export const DeleteAccount = ({
  open,
  onClose,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
}) => {
  const remove = useAction(deleteAccountAtom);

  const confirm = async (email: string) => {
    const outcome = await remove.run({ payload: { email: email.trim() } });

    if (outcome.ok) {
      window.location.assign("/");

      // The page is going away: stay busy until it does.
      return await new Promise<never>(() => undefined);
    }

    switch (outcome.error) {
      case "sole_owner":
        return <HandOver slugs={outcome.orgs ?? []} />;
      case "email_mismatch":
        return "That is not the email address you are signed in with.";
      case "person_required":
        return "Only a person can delete their account, not a service token.";
      case "deletion_incomplete":
        return "Something is still being removed. Press Delete my account again to continue.";
      default:
        return outcome.detail ?? outcome.message;
    }
  };

  return (
    <TypedConfirm
      open={open}
      title="Delete my account?"
      label="Your email address"
      action="Delete my account"
      busyAction="Deleting…"
      onConfirm={confirm}
      onClose={onClose}
    >
      <p>
        You leave every org you belong to, and everything of yours in them is deleted: your proxy
        keys and your private accounts and provider keys. An org where you are the only member is
        deleted with all its data. This is immediate and permanent; there is no grace period and
        nothing can be restored.
      </p>
      <p>The first org is never deleted: if you are alone there, you only leave it.</p>
      <p>Type the email address you are signed in with to confirm.</p>
    </TypedConfirm>
  );
};
