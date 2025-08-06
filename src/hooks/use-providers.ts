import type { UseQueryResult } from "@tanstack/react-query";
import { useConfig } from "~/contexts/config";
import type { Config } from "~/schemas/config";

export const useProvidersConfig = () => {
  const { data: config, ...rest } = useConfig();
  return {
    data: config?.providers,
    ...rest,
  } as UseQueryResult<Config["providers"], Error>;
};
