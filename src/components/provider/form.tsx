import { useStore } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type * as z from "zod";
import { useConfigInterface } from "~/hooks/use-config";
import { useForm } from "~/hooks/use-form";
import { useModels } from "~/hooks/use-models";
import { useStrongholdStore } from "~/hooks/use-stronghold";
import {
  type PreloadedProviderId,
  preloadedProviders,
} from "~/lib/preloaded-providers";
import { queryKeys } from "~/lib/query-keys";
import {
  ProviderConfig,
  ProviderId,
  type ProviderModelConfig,
  ProviderSdk,
} from "~/schemas/config/provider";
import type { Prettify } from "~/types/prettify";
import { createId } from "~/utils/id";
import { AutoCompleteInput } from "../ui/autocomplete-input";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { ProviderAuthForm } from "./auth/form";
import { HeaderMultiselector } from "./header-multiselector";
import { ModelMultiselector } from "./model-multiselector";
import { JsonEditor } from "./options-json-editor";

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
  const config = useConfigInterface();
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
      const currentConfig = await config.get();
      const providerConfig = {
        ...rest,
        auth,
      };
      await config.set({
        ...currentConfig,
        providers: {
          ...currentConfig.providers,
          [id]: providerConfig,
        },
      });
    },
    onSuccess: () => {
      setIdSearchValue("");
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
      id: props.providerId,
      ...props.providerConfig,
    } as Provider,
    validators: {
      onChange: Provider,
    },
    onSubmit: ({ value }) => submitMutation.mutateAsync(value),
  });

  const { data: models } = useModels();
  const currentId = useStore(form.store, (state) => state.values.id);
  useEffect(() => {
    if (currentId && Object.keys(preloadedProviders).includes(currentId)) {
      form.setFieldValue(
        "models",
        models?.data
          .filter((model) => model.owned_by === currentId)
          .reduce(
            (acc, model) => {
              acc[model.id] = {};
              return acc;
            },
            {} as Record<string, ProviderModelConfig>,
          ) || {},
      );
    }
  }, [currentId, models?.data, form.setFieldValue]);

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
                disabled={!!props.providerId}
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
        <div className="flex flex-col gap-2">
          <Label className="text-lg">Additional Headers</Label>
          <form.AppField name="headers">
            {(field) => (
              <div className="flex flex-col gap-1">
                <HeaderMultiselector
                  value={field.state.value ?? {}}
                  onChange={field.setValue}
                />
                <field.FieldError />
              </div>
            )}
          </form.AppField>
        </div>
        <div className="flex flex-col gap-2">
          <Label className="text-lg">Provider Options</Label>
          <div className="flex flex-col gap-4">
            <form.AppField name="options">
              {(field) => (
                <div className="flex flex-col gap-1">
                  <JsonEditor
                    value={field.state.value ?? {}}
                    onChange={field.setValue}
                  />
                  <field.FieldError />
                </div>
              )}
            </form.AppField>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <Label className="text-lg">Models</Label>
          <form.AppField name="models">
            {(field) => (
              <div className="flex flex-col gap-1">
                <ModelMultiselector
                  value={field.state.value ?? {}}
                  onChange={field.setValue}
                />
                <field.FieldError />
              </div>
            )}
          </form.AppField>
        </div>
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
