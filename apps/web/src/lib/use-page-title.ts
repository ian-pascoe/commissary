import { useEffect } from "react";

/** Sets the document title to "<page> – Commissary" while the page is shown. */
export const usePageTitle = (page: string): void => {
  useEffect(() => {
    document.title = `${page} – Commissary`;
  }, [page]);
};
