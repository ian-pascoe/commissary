import { useRouteContext } from "@tanstack/react-router";

export const useApiClient = () => {
  const apiClient = useRouteContext({
    from: "__root__",
    select: (s) => s.apiClient,
  });
  return apiClient;
};
