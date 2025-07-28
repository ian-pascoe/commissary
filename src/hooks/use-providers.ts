import { useQuery } from "@tanstack/react-query";
import { useConfig } from "./use-config";

export const useProviders = () => {
  const config = useConfig();
  const query = useQuery({
    queryKey: ["providers"],
    queryFn: async () => {
      const providers = await config.get().then((c) => c.providers || {});
      return providers;
    },
  });
  const { data: providers, ...rest } = query;
  return {
    ...rest,
    providers,
  };
};
