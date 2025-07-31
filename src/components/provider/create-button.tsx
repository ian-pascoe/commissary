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
import { ProviderForm } from "./form";

export type CreateProviderButtonProps = ComponentProps<typeof Button>;

export const CreateProviderButton = ({
  children,
  ...props
}: CreateProviderButtonProps) => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button {...props}>{children ?? "Create Provider"}</Button>
      </DialogTrigger>
      <DialogContent className="max-h-screen overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New Provider</DialogTitle>
          <DialogDescription>
            Create a new provider in the system
          </DialogDescription>
        </DialogHeader>
        <ProviderForm onSuccess={() => setIsOpen(false)} />
      </DialogContent>
    </Dialog>
  );
};
