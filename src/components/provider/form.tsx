import { useStore } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type * as z from "zod";
import { useConfig } from "~/hooks/use-config";
import { useForm } from "~/hooks/use-form";
import { useStrongholdStore } from "~/hooks/use-stronghold";
import {
  type PreloadedProviderId,
  preloadedProviders,
} from "~/lib/preloaded-providers";
import { queryKeys } from "~/lib/query-keys";
import {
  ProviderConfig,
  ProviderId,
  ProviderSdk,
} from "~/schemas/config/provider";
import type { Prettify } from "~/types/prettify";
import { createId } from "~/utils/id";
import { AutoCompleteInput } from "../ui/autocomplete-input";
import { Button } from "../ui/button";
import { ProviderAuthForm } from "./auth/form";
import { ProviderModelForm } from "./model/form";

export const Provider = ProviderConfig.extend({
  id: ProviderId.meta({ description: "Unique identifier for the provider" }),
});
export type Provider = Prettify<
  Omit<z.infer<typeof Provider>, "id"> & {
    id: PreloadedProviderId | (string & {});
  }
>;

interface ProviderFormProps {
  providerId?: string;
  providerConfig?: ProviderConfig;
  onSuccess?: () => void;
}

export const ProviderForm = (props: ProviderFormProps) => {
  const config = useConfig();
  const strongholdStore = useStrongholdStore();
  const queryClient = useQueryClient();

  const [idSearchValue, setIdSearchValue] = useState(props.providerId || "");

  const submitMutation = useMutation({
    mutationFn: async (input: Provider) => {
      const { id, auth, ...rest } = Provider.parse(input);
      if (auth) {
        switch (auth.type) {
          case "api-key": {
            if (auth.apiKey?.startsWith("sh(") && auth.apiKey.endsWith(")")) {
              break; // already a stronghold reference
            }
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
    onSuccess: () => {
      setIdSearchValue("");
      props.onSuccess?.();
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.providers.all });
    },
  });

  const form = useForm({
    defaultValues: {
      id: props.providerId,
      ...props.providerConfig,
    } as Provider,
    validators: {
      onChange: Provider,
    },
    onSubmit: ({ value }) => submitMutation.mutateAsync(value),
  });

  const values = useStore(form.store, (state) => state.values);
  useEffect(() => {
    console.log("Form values changed:", JSON.stringify(values, null, 2));
  }, [values]);

  const errors = useStore(form.store, (state) => state.errors);
  useEffect(() => {
    if (errors.length) {
      console.error("Form errors:", JSON.stringify(errors, null, 2));
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
              <AutoCompleteInput
                selectedValue={field.state.value}
                onSelectedValueChange={field.setValue}
                searchValue={idSearchValue}
                onSearchValueChange={setIdSearchValue}
                items={Object.keys(preloadedProviders).map((key) => ({
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
        <form.AppField name="name">
          {(field) => (
            <div className="flex flex-col gap-1">
              <field.Label>Name (Optional)</field.Label>
              <field.Input
                value={field.state.value}
                onChange={(e) => field.setValue(e.target.value)}
              />
            </div>
          )}
        </form.AppField>
        <form.Subscribe selector={(state) => state.values.id}>
          {(id) =>
            !Object.keys(preloadedProviders).includes(id) && (
              <form.AppField name="sdk">
                {(field) => (
                  <div className="flex flex-col gap-1">
                    <field.Label>SDK (Optional)</field.Label>
                    <field.Select
                      value={field.state.value}
                      onValueChange={(value) =>
                        field.setValue(value as typeof field.state.value)
                      }
                    >
                      <field.SelectTrigger>
                        <field.SelectValue placeholder="Select SDK" />
                      </field.SelectTrigger>
                      <field.SelectContent>
                        {ProviderSdk.options.map((option) => (
                          <field.SelectItem key={option} value={option}>
                            {option}
                          </field.SelectItem>
                        ))}
                      </field.SelectContent>
                    </field.Select>
                  </div>
                )}
              </form.AppField>
            )
          }
        </form.Subscribe>
        <form.AppField name="baseUrl">
          {(field) => (
            <div className="flex flex-col gap-1">
              <field.Label>Base URL (Optional)</field.Label>
              <field.Input
                placeholder="https://api.example.com"
                value={field.state.value || ""}
                onChange={(e) => field.setValue(e.target.value || undefined)}
              />
              <field.FieldError />
            </div>
          )}
        </form.AppField>
        <ProviderAuthForm form={form} />
        <form.Subscribe selector={(state) => state.values.id}>
          {(id) =>
            id &&
            !Object.keys(preloadedProviders).includes(id) && (
              <ProviderModelForm form={form} />
            )
          }
        </form.Subscribe>
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
