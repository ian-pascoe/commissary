import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  experimental_createMCPClient as createMcpClient,
  type experimental_MCPClient as McpClient,
} from "ai";
import type { Config } from "~/schemas/config";
import { TauriMcpTransport } from "./mcp-transport/tauri";

export const createMcpClients = async (mcpConfig: Config["mcp"]) => {
  console.log("[MCP] Constructing MCP clients from config:", mcpConfig);

  const clients: Record<string, McpClient> = {};
  const clientPromises = Object.entries(mcpConfig ?? {}).map(
    async ([id, serverConfig]) => {
      if (!serverConfig.enabled) {
        console.log(`[MCP] Server ${id} is disabled, skipping.`);
        return null;
      }

      let mcpClient: McpClient;
      if (serverConfig.type === "stdio") {
        console.log(`[MCP] Creating stdio MCP client for server ${id}`);
        mcpClient = await createMcpClient({
          transport: new TauriMcpTransport(id, serverConfig),
        });
        console.log(`[MCP] Created stdio MCP client for server ${id}`);
      } else if (serverConfig.type === "sse") {
        console.log(`[MCP] Creating SSE MCP client for server ${id}`);
        mcpClient = await createMcpClient({
          transport: {
            type: "sse",
            url: serverConfig.url,
            headers: serverConfig.headers,
          },
        });
        console.log(`[MCP] Created SSE MCP client for server ${id}`);
      } else if (serverConfig.type === "http") {
        console.log(`[MCP] Creating HTTP MCP client for server ${id}`);
        mcpClient = await createMcpClient({
          transport: new StreamableHTTPClientTransport(
            new URL(serverConfig.url),
            { requestInit: { headers: serverConfig.headers } },
          ),
        });
        console.log(`[MCP] Created HTTP MCP client for server ${id}`);
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
      clients[result.id] = result.mcpClient;
    }
  }

  console.log(
    `[MCP] Constructed ${Object.keys(clients).length} MCP clients:`,
    Object.keys(clients),
  );
  return clients;
};
