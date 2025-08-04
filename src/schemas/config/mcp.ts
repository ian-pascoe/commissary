import z from "zod";

export const BaseMcpConfig = z.object({
  enabled: z.boolean().default(true).meta({
    description: "Whether this MCP server is enabled",
  }),
  excludeTools: z.optional(z.array(z.string())).meta({
    description: "List of tool names to exclude from this MCP server",
  }),
});

export const LocalMcpConfig = z.object({
  ...BaseMcpConfig.shape,
  type: z.literal("stdio").meta({ description: "Use a local MCP server" }),
  command: z.array(z.string()).meta({
    description: "The command to start the local MCP server",
  }),
  environment: z.optional(z.record(z.string(), z.string())).meta({
    description: "Environment variables for the local MCP server",
  }),
  cwd: z.optional(z.string()).meta({
    description: "Working directory for the local MCP server",
  }),
});
export type LocalMcpConfig = z.infer<typeof LocalMcpConfig>;

export const RemoteMcpConfig = z.object({
  ...BaseMcpConfig.shape,
  type: z
    .enum(["sse", "http"])
    .meta({ description: "Use a SSE or streamable HTTP MCP server" }),
  url: z.url().meta({ description: "The URL of the MCP server" }),
  headers: z
    .optional(z.record(z.string(), z.string()))
    .meta({ description: "Headers to include in requests" }),
});
export type RemoteMcpConfig = z.infer<typeof RemoteMcpConfig>;

export const McpConfig = z.discriminatedUnion("type", [
  LocalMcpConfig,
  RemoteMcpConfig,
]);
export type McpConfig = z.infer<typeof McpConfig>;
export type McpConfigInput = z.input<typeof McpConfig>;
