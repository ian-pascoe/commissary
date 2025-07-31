import z from "zod";

export const McpConfig = z
  .object({
    enabled: z
      .optional(z.boolean())
      .default(true)
      .meta({ description: "Whether MCP is enabled" }),
  })
  .and(
    z.discriminatedUnion("type", [
      z.object({
        type: z.literal("local"),
        command: z.array(z.string()),
        environment: z.optional(z.record(z.string(), z.string())).meta({
          description: "Environment variables for the local MCP process",
        }),
      }),
      z.object({
        type: z.literal("remote"),
        url: z.url().meta({ description: "The URL of the MCP server" }),
        headers: z
          .optional(z.record(z.string(), z.string()))
          .meta({ description: "Headers to include in requests" }),
      }),
    ]),
  );
export type McpConfig = z.infer<typeof McpConfig>;
export type McpConfigInput = z.input<typeof McpConfig>;
