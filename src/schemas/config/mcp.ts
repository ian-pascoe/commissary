import z from "zod";

export const LocalMcpConfig = z.object({
  type: z.literal("stdio").meta({ description: "Use a local MCP process" }),
  command: z.array(z.string()).meta({
    description: "The command to start the local MCP process",
  }),
  environment: z
    .optional(z.record(z.string(), z.string()))
    .meta({ description: "Environment variables for the local MCP process" }),
});
export type LocalMcpConfig = z.infer<typeof LocalMcpConfig>;

export const RemoteMcpConfig = z.object({
  type: z
    .enum(["sse", "http"])
    .meta({ description: "Use a SSE or streamable HTTP MCP server" }),
  url: z.url().meta({ description: "The URL of the MCP server" }),
  headers: z
    .optional(z.record(z.string(), z.string()))
    .meta({ description: "Headers to include in requests" }),
});
export type RemoteMcpConfig = z.infer<typeof RemoteMcpConfig>;

export const McpConfig = z
  .object({
    enabled: z
      .optional(z.boolean())
      .default(true)
      .meta({ description: "Whether MCP is enabled" }),
  })
  .and(z.discriminatedUnion("type", [LocalMcpConfig, RemoteMcpConfig]));
export type McpConfig = z.infer<typeof McpConfig>;
export type McpConfigInput = z.input<typeof McpConfig>;
