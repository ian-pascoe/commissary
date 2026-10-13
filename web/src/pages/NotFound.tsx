// Any address the panel has no page for.
import { Link } from "@tanstack/react-router";
import { usePageTitle } from "../lib/use-page-title.ts";
import styles from "./NotFound.module.css";

export const NotFound = () => {
  usePageTitle("Page not found");

  return (
    <div className={styles["page"]}>
      <h1 className={styles["title"]}>Page not found</h1>
      <p className={styles["lead"]}>
        Nothing lives at this address. Pick a page above, or go back to the{" "}
        <Link to="/">overview</Link>.
      </p>
    </div>
  );
};
