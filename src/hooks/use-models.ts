import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "~/lib/query-keys";
import { useApiClient } from "./use-api-client";

export const useModels = () => {
  const apiClient = useApiClient();

  const query = useQuery({
    queryKey: queryKeys.models.all(),
    queryFn: async () => {
      const response = await apiClient.openai.v1.models.$get();
      if (!response.ok) {
        throw new Error("Failed to fetch models");
      }
      return await response.json();
    },
  });

  return query;
};
