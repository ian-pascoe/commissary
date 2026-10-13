// A page the caller's role does not open (a plain member asking for an admin page).
import { Link } from "@tanstack/react-router";
import { usePageTitle } from "../lib/use-page-title.ts";
import styles from "./NotFound.module.css";

export const NotAllowed = ({ home }: { readonly home: string }) => {
  usePageTitle("Not available to you");

  return (
    <div className={styles["page"]}>
      <h1 className={styles["title"]}>Not available to you</h1>
      <p className={styles["lead"]}>
        This page is for the org&rsquo;s admins. As a member you can see your own usage; ask an
        admin of the org if you need more. Go to <Link to={home}>your usage</Link>.
      </p>
    </div>
  );
};
