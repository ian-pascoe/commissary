import { type ComponentProps, useState } from "react";
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

export type CreateMcpButtonProps = ComponentProps<typeof Button>;

export const CreateMcpButton = ({
  children,
  ...props
}: CreateMcpButtonProps) => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button {...props}>{children ?? "Create MCP Server"}</Button>
      </DialogTrigger>
      <DialogContent className="max-h-screen overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New MCP Server</DialogTitle>
          <DialogDescription>
            Create a new Model Context Protocol server
          </DialogDescription>
        </DialogHeader>
        <McpForm onSuccess={() => setIsOpen(false)} />
      </DialogContent>
    </Dialog>
  );
};
