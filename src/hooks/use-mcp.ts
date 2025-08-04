import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "~/lib/query-keys";
import { constructMcpClients } from "~/utils/contruct-mcp-clients";
import { useConfig } from "./use-config";

export const useMcpConfig = () => {
  const config = useConfig();
  return useQuery({
    queryKey: queryKeys.config.mcp.all(),
    queryFn: async () => {
      const mcpConfig = await config.get().then((c) => c.mcp);
      return mcpConfig;
    },
  });
};

export const useMcpClients = () => {
  const { data: mcpConfig } = useMcpConfig();

  return useQuery({
    queryKey: queryKeys.config.mcp.clients(mcpConfig),
    queryFn: async () => {
      return await constructMcpClients(mcpConfig);
    },
  });
};
