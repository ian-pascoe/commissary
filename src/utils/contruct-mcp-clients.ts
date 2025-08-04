import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  experimental_createMCPClient as createMcpClient,
  type experimental_MCPClient as McpClient,
} from "ai";
import type { Config } from "~/schemas/config";
import { TauriMcpTransport } from "./mcp-transport/tauri";

export const constructMcpClients = async (mcpConfig: Config["mcp"]) => {
  const clients = new Map<string, McpClient>();

  const clientPromises = Object.entries(mcpConfig ?? {}).map(
    async ([id, serverConfig]) => {
      if (!serverConfig.enabled) return null;

      let mcpClient: McpClient;
      if (serverConfig.type === "stdio") {
        mcpClient = await createMcpClient({
          transport: new TauriMcpTransport(id, serverConfig),
        });
      } else if (serverConfig.type === "sse") {
        mcpClient = await createMcpClient({
          transport: {
            type: "sse",
            url: serverConfig.url,
            headers: serverConfig.headers,
          },
        });
      } else if (serverConfig.type === "http") {
        mcpClient = await createMcpClient({
          transport: new StreamableHTTPClientTransport(
            new URL(serverConfig.url),
            {
              requestInit: {
                headers: serverConfig.headers,
              },
            },
          ),
        });
      } else {
        console.warn(`Unknown MCP config type for server ${id}, skipping.`);
        return null;
      }
      return { id, mcpClient };
    },
  );

  const results = await Promise.all(clientPromises);
  for (const result of results) {
    if (result) {
      clients.set(result.id, result.mcpClient);
    }
  }

  return clients;
};
