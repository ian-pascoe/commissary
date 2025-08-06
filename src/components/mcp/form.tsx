import { useStore } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import * as z from "zod";
import { useConfigInterface } from "~/hooks/use-config";
import { useForm } from "~/hooks/use-form";
import { queryKeys } from "~/lib/query-keys";
import { McpConfig } from "~/schemas/config/mcp";
import { HeaderMultiselector } from "../provider/header-multiselector";
import { Button } from "../ui/button";
import { EnvironmentMultiselector } from "./environment-multiselector";
import { ToolsMultiselector } from "./tools-multiselector";

export const Mcp = McpConfig.and(
  z.object({
    id: z.string().min(1, "ID is required"),
  }),
);

export type Mcp = z.infer<typeof Mcp>;

interface McpFormProps {
  mcpId?: string;
  mcpConfig?: McpConfig;
  onSuccess?: () => void;
}

export const McpForm = (props: McpFormProps) => {
  const config = useConfigInterface();
  const queryClient = useQueryClient();

  const submitMutation = useMutation({
    mutationFn: async (input: Mcp) => {
      const { id, ...rest } = input;
      const currentConfig = await config.get();
      await config.set({
        ...currentConfig,
        mcp: {
          ...currentConfig.mcp,
          [id]: rest as McpConfig,
        },
      });
    },
    onSuccess: () => {
      props.onSuccess?.();
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.config.all(),
      });
    },
  });

  const form = useForm({
    defaultValues: {
      id: props.mcpId || "",
      type: props.mcpConfig?.type || "stdio",
      enabled: props.mcpConfig?.enabled ?? true,
      excludeTools: props.mcpConfig?.excludeTools,
      ...(props.mcpConfig?.type === "stdio"
        ? {
            command: props.mcpConfig.command,
            environment: props.mcpConfig.environment,
            cwd: props.mcpConfig.cwd,
          }
        : {}),
      ...(props.mcpConfig?.type === "sse" || props.mcpConfig?.type === "http"
        ? {
            url: props.mcpConfig.url,
            headers: props.mcpConfig.headers,
          }
        : {}),
    } as Mcp,
    onSubmit: ({ value }) => submitMutation.mutateAsync(value),
  });

  const values = useStore(form.store, (state) => state.values);
  useEffect(() => {
    console.log("MCP Form values changed:", JSON.stringify(values, null, 2));
  }, [values]);

  const errors = useStore(form.store, (state) => state.errors);
  useEffect(() => {
    if (errors.length) {
      console.error("MCP Form errors:", JSON.stringify(errors, null, 2));
    }
  }, [errors]);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        form.handleSubmit();
      }}
      className="flex flex-col gap-6"
    >
      <div className="flex flex-col gap-4">
        <form.AppField name="id">
          {(field) => (
            <div className="flex flex-col gap-1">
              <field.Label>Identifier</field.Label>
              <field.Input
                value={field.state.value}
                onChange={(e) => field.setValue(e.target.value)}
                placeholder="Enter MCP server ID"
                disabled={!!props.mcpId}
              />
              <field.FieldError />
            </div>
          )}
        </form.AppField>

        <form.AppField name="type">
          {(field) => (
            <div className="flex flex-col gap-1">
              <field.Label>Type</field.Label>
              <field.Select
                value={field.state.value}
                onValueChange={(value) =>
                  field.setValue(value as typeof field.state.value)
                }
              >
                <field.SelectTrigger>
                  <field.SelectValue placeholder="Select MCP type" />
                </field.SelectTrigger>
                <field.SelectContent>
                  <field.SelectItem value="stdio">
                    Local (stdio)
                  </field.SelectItem>
                  <field.SelectItem value="sse">Remote (SSE)</field.SelectItem>
                  <field.SelectItem value="http">
                    Remote (HTTP)
                  </field.SelectItem>
                </field.SelectContent>
              </field.Select>
              <field.FieldError />
            </div>
          )}
        </form.AppField>

        <form.AppField name="enabled">
          {(field) => (
            <div className="flex items-center gap-2">
              <field.Input
                type="checkbox"
                checked={field.state.value}
                onChange={(e) => field.setValue(e.target.checked)}
                className="size-4"
              />
              <field.Label>Enabled</field.Label>
            </div>
          )}
        </form.AppField>

        <form.Subscribe selector={(state) => state.values.type}>
          {(type) =>
            type === "stdio" ? (
              <>
                <form.AppField name="command">
                  {(field) => (
                    <div className="flex flex-col gap-1">
                      <field.Label>Command</field.Label>
                      <field.Input
                        value={
                          Array.isArray(field.state.value)
                            ? field.state.value.join(" ")
                            : ""
                        }
                        onChange={(e) =>
                          field.setValue(e.target.value.split(" "))
                        }
                        placeholder="node server.js"
                      />
                      <field.FieldError />
                    </div>
                  )}
                </form.AppField>

                <form.AppField name="cwd">
                  {(field) => (
                    <div className="flex flex-col gap-1">
                      <field.Label>Working Directory (Optional)</field.Label>
                      <field.Input
                        value={field.state.value || ""}
                        onChange={(e) =>
                          field.setValue(e.target.value || undefined)
                        }
                        placeholder="/path/to/server"
                      />
                      <field.FieldError />
                    </div>
                  )}
                </form.AppField>

                <form.AppField name="environment">
                  {(field) => (
                    <div className="flex flex-col gap-1">
                      <field.Label>
                        Environment Variables (Optional)
                      </field.Label>
                      <EnvironmentMultiselector
                        value={field.state.value || {}}
                        onChange={field.setValue}
                      />
                      <field.FieldError />
                    </div>
                  )}
                </form.AppField>
              </>
            ) : (
              <>
                <form.AppField name="url">
                  {(field) => (
                    <div className="flex flex-col gap-1">
                      <field.Label>URL</field.Label>
                      <field.Input
                        value={field.state.value || ""}
                        onChange={(e) => field.setValue(e.target.value)}
                        placeholder="https://api.example.com/mcp"
                      />
                      <field.FieldError />
                    </div>
                  )}
                </form.AppField>

                <form.AppField name="headers">
                  {(field) => (
                    <div className="flex flex-col gap-1">
                      <field.Label>Headers (Optional)</field.Label>
                      <HeaderMultiselector
                        value={field.state.value || {}}
                        onChange={field.setValue}
                      />
                      <field.FieldError />
                    </div>
                  )}
                </form.AppField>
              </>
            )
          }
        </form.Subscribe>

        <form.AppField name="excludeTools">
          {(field) => (
            <div className="flex flex-col gap-1">
              <field.Label>Exclude Tools (Optional)</field.Label>
              <ToolsMultiselector
                value={field.state.value || []}
                onChange={field.setValue}
              />
              <field.FieldError />
            </div>
          )}
        </form.AppField>
      </div>

      <div className="flex justify-end">
        <form.Subscribe
          selector={(s) => ({
            isSubmitting: s.isSubmitting,
            canSubmit: s.canSubmit,
          })}
        >
          {({ isSubmitting, canSubmit }) => (
            <Button type="submit" disabled={isSubmitting || !canSubmit}>
              {isSubmitting ? "Saving..." : "Save"}
            </Button>
          )}
        </form.Subscribe>
      </div>
    </form>
  );
};
