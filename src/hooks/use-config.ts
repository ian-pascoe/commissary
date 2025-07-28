import { useRouteContext } from "@tanstack/react-router";

export const useConfig = () => {
  const config = useRouteContext({ from: "__root__", select: (s) => s.config });
  return config;
};
