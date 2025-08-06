import { useRouteContext } from "@tanstack/react-router";

export const useConfigInterface = () => {
  const config = useRouteContext({
    from: "__root__",
    select: (s) => s.config,
  });

  return config;
};
