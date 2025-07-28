import { useRouteContext } from "@tanstack/react-router";

export const useGeneralStore = () => {
  const store = useRouteContext({ from: "__root__", select: (s) => s.generalStore });
  return store;
};
