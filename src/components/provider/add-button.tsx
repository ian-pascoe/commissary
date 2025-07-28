import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ComponentProps, useState } from "react";
import * as z from "zod";
import { useConfig } from "~/hooks/use-config";
import { useForm } from "~/hooks/use-form";
import { useStrongholdStore } from "~/hooks/use-stronghold";
import { providers } from "~/lib/providers";
import { ProviderConfig } from "~/schemas/config/provider";
import { createId } from "~/utils/id";
import { AutoCompleteInput } from "../ui/autocomplete-input";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";

export const CreateProvider = ProviderConfig.extend({
  id: z.string().min(1, "Provider ID is required"),
});
export type CreateProvider = z.infer<typeof CreateProvider>;

export type AddProviderButtonProps = ComponentProps<typeof Button>;
export const AddProviderButton = ({
  children,
  ...props
}: AddProviderButtonProps) => {
  const config = useConfig();
  const strongholdStore = useStrongholdStore();
  const queryClient = useQueryClient();

  const [isOpen, setIsOpen] = useState(false);
  const [idSearchValue, setIdSearchValue] = useState("");

  const submitMutation = useMutation({
    mutationFn: async (input: CreateProvider) => {
      const { id, auth, ...rest } = CreateProvider.parse(input);
      if (auth) {
        switch (auth.type) {
          case "api-key": {
            const strongholdId = createId();
            await strongholdStore.set(strongholdId, auth.apiKey);
            auth.apiKey = `sh(${strongholdId})`;
            break;
          }
          default: {
            throw new Error(`Unsupported auth type: ${auth.type}`);
          }
        }
      }
      const providerConfig = {
        ...rest,
        auth,
      };
      await config.merge({
        providers: {
          [id]: providerConfig,
        },
      });
    },
    onSettled: () => {
      setIsOpen(false);
      setIdSearchValue("");
      queryClient.invalidateQueries({ queryKey: ["providers"] });
    },
  });

  const form = useForm({
    defaultValues: {
      auth: {
        type: "api-key",
      },
    } as CreateProvider,
    validators: {
      onChange: CreateProvider,
    },
    onSubmit: ({ value }) => submitMutation.mutateAsync(value),
  });

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button {...props}>{children ?? "Add Provider"}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Provider</DialogTitle>
          <DialogDescription>
            Add a new provider to the system
          </DialogDescription>
        </DialogHeader>
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
                  <AutoCompleteInput
                    selectedValue={field.state.value}
                    onSelectedValueChange={field.setValue}
                    searchValue={idSearchValue}
                    onSearchValueChange={setIdSearchValue}
                    items={Object.keys(providers).map((key) => ({
                      value: key,
                      label: key,
                    }))}
                    allowCustomValues
                    placeholder="Select or enter a provider ID"
                  />
                  <field.FieldError />
                </div>
              )}
            </form.AppField>
            <form.Subscribe selector={(state) => state.values.id}>
              {(id) => {
                const name = id
                  ? providers[id as keyof typeof providers]?.name || ""
                  : "";
                return (
                  <form.AppField name="name">
                    {(field) => (
                      <div className="flex flex-col gap-1">
                        <field.Label>Name (Optional)</field.Label>
                        <field.Input
                          value={field.state.value || name}
                          onChange={(e) => field.setValue(e.target.value)}
                        />
                      </div>
                    )}
                  </form.AppField>
                );
              }}
            </form.Subscribe>
            <form.AppField name="baseUrl">
              {(field) => (
                <div className="flex flex-col gap-1">
                  <field.Label>Base URL (Optional)</field.Label>
                  <field.Input
                    placeholder="https://api.example.com"
                    value={field.state.value || ""}
                    onChange={(e) => field.setValue(e.target.value)}
                  />
                  <field.FieldError />
                </div>
              )}
            </form.AppField>
            <form.Subscribe selector={(state) => state.values.id}>
              {(id) => {
                // TODO: Dynamically render auth fields based on provider capabilities
                return (
                  <form.AppField name="auth.apiKey">
                    {(field) => (
                      <div className="flex flex-col gap-1">
                        <field.Label>API Key</field.Label>
                        <field.Input
                          value={field.state.value}
                          onChange={(e) => field.setValue(e.target.value)}
                        />
                      </div>
                    )}
                  </form.AppField>
                );
              }}
            </form.Subscribe>
          </div>
          <DialogFooter>
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
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
