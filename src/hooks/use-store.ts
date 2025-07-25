import { useRouteContext } from "@tanstack/react-router";

export const useStore = () => {
  const store = useRouteContext({ from: "__root__", select: (s) => s.store });
  return store;
};
