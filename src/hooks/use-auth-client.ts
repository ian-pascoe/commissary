import { useRouteContext } from "@tanstack/react-router";

export const useAuthClient = () => {
  const authClient = useRouteContext({
    from: "__root__",
    select: (s) => s.authClient,
  });
  return authClient;
};
