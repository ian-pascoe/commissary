import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "~/lib/query-keys";
import { useConfig } from "./use-config";

export const useProviders = () => {
  const config = useConfig();
  return useQuery({
    queryKey: queryKeys.providers.all,
    queryFn: async () => {
      const providers = await config.get().then((c) => c.providers);
      return providers;
    },
  });
};
