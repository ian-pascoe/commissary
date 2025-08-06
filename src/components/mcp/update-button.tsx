import { type ComponentProps, useState } from "react";
import type { McpConfig } from "~/schemas/config/mcp";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { McpForm } from "./form";

export type UpdateMcpButtonProps = ComponentProps<typeof Button> & {
  mcpId: string;
  mcpConfig: McpConfig;
};

export const UpdateMcpButton = ({
  children,
  mcpId,
  mcpConfig,
  ...props
}: UpdateMcpButtonProps) => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button {...props}>{children ?? "Update MCP Server"}</Button>
      </DialogTrigger>
      <DialogContent className="max-h-screen overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Update MCP Server</DialogTitle>
          <DialogDescription>
            Update the MCP server configuration
          </DialogDescription>
        </DialogHeader>
        <McpForm
          mcpId={mcpId}
          mcpConfig={mcpConfig}
          onSuccess={() => setIsOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
};
