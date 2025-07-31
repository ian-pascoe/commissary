import { type ComponentProps, useState } from "react";
import type { ProviderConfig } from "~/schemas/config/provider";
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

export type UpdateProviderButtonProps = ComponentProps<typeof Button> & {
  providerId: string;
  providerConfig: ProviderConfig;
};

export const UpdateProviderButton = ({
  children,
  providerId,
  providerConfig,
  ...props
}: UpdateProviderButtonProps) => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button {...props}>{children ?? "Update Provider"}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Update Provider</DialogTitle>
          <DialogDescription>
            Update the provider configuration
          </DialogDescription>
        </DialogHeader>
        <ProviderForm
          providerId={providerId}
          providerConfig={providerConfig}
          onSuccess={() => setIsOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
};
