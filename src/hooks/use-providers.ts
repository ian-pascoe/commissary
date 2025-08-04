import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "~/lib/query-keys";
import { useConfig } from "./use-config";

export const useProvidersConfig = () => {
  const config = useConfig();
  return useQuery({
    queryKey: queryKeys.config.providers.all(),
    queryFn: async () => {
      const providersConfig = await config.get().then((c) => c.providers);
      return providersConfig;
    },
  });
};
