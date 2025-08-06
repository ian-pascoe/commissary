import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash } from "lucide-react";
import { useConfigInterface } from "~/hooks/use-config";
import { useMcpConfig } from "~/hooks/use-mcp";
import { queryKeys } from "~/lib/query-keys";
import { Button } from "../ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../ui/card";
import { Spinner } from "../ui/kibo-ui/spinner";
import { CreateMcpButton } from "./create-button";
import { UpdateMcpButton } from "./update-button";

export const McpSettingsCard = () => {
  const config = useConfigInterface();
  const queryClient = useQueryClient();
  const { data: mcpConfig, status } = useMcpConfig();

  const deleteMcpMutation = useMutation({
    mutationFn: async (id: string) => {
      const currentConfig = await config.get();
      await config.set({
        ...currentConfig,
        mcp: Object.fromEntries(
          Object.entries(currentConfig.mcp || {}).filter(([key]) => key !== id),
        ),
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.config.all(),
      });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Model Context Protocol (MCP)</CardTitle>
        <CardDescription>Configure your MCP servers here.</CardDescription>
      </CardHeader>
      <CardContent>
        {status === "pending" ? (
          <Spinner />
        ) : status === "error" ? (
          <div className="text-red-500">Error loading MCP servers.</div>
        ) : Object.keys(mcpConfig ?? {}).length === 0 ? (
          <div>No MCP servers configured.</div>
        ) : (
          <ul className="space-y-2">
            {Object.entries(mcpConfig ?? {}).map(([mcpId, mcpConfig]) => {
              return (
                <li
                  key={mcpId}
                  className="flex items-center justify-between rounded-md border p-4"
                >
                  <div className="flex flex-col gap-2">
                    <div className="font-medium">{mcpId}</div>
                    <div className="text-muted-foreground text-sm">
                      {mcpConfig.type}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <UpdateMcpButton mcpId={mcpId} mcpConfig={mcpConfig}>
                      <Pencil />
                    </UpdateMcpButton>
                    <Button onClick={() => deleteMcpMutation.mutate(mcpId)}>
                      <Trash />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
      <CardFooter className="flex justify-end">
        <CreateMcpButton>
          <Plus />
          New
        </CreateMcpButton>
      </CardFooter>
    </Card>
  );
};
