import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useConfig } from "~/contexts/config";
import { queryKeys } from "~/lib/query-keys";
import type { Config } from "~/schemas/config";
import { createMcpClients } from "~/utils/create-mcp-clients";

export const useMcpConfig = () => {
  const { data: config, ...rest } = useConfig();
  return {
    data: config?.mcp,
    ...rest,
  } as UseQueryResult<Config["mcp"], Error>;
};

export const useMcpClients = () => {
  const { data: mcpConfig } = useMcpConfig();

  const query = useQuery({
    queryKey: queryKeys.config.mcpClients(mcpConfig),
    queryFn: () => createMcpClients(mcpConfig),
  });

  useEffect(() => {
    return () => {
      for (const client of Object.values(query.data ?? {})) {
        client.close();
      }
    };
  }, [query.data]);

  return query;
};
