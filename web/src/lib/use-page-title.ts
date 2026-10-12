import { useEffect } from "react";

/** Sets the document title to "<page> – cf-llm-proxy" while the page is shown. */
export const usePageTitle = (page: string): void => {
  useEffect(() => {
    document.title = `${page} – cf-llm-proxy`;
  }, [page]);
};
