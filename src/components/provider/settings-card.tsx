import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toMerged } from "es-toolkit";
import { Pencil, Plus, Trash } from "lucide-react";
import { useMemo } from "react";
import { useConfigInterface } from "~/hooks/use-config";
import { useProvidersConfig } from "~/hooks/use-providers";
import { preloadedProviders } from "~/lib/preloaded-providers";
import { queryKeys } from "~/lib/query-keys";
import { Button } from "../ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../ui/card";
import { Spinner } from "../ui/kibo-ui/spinner";
import { CreateProviderButton } from "./create-button";
import { ProviderIcon } from "./icon";
import { UpdateProviderButton } from "./update-button";

export const ProviderSettingsCard = () => {
  const config = useConfigInterface();
  const queryClient = useQueryClient();
  const { data: providersConfig, status } = useProvidersConfig();

  const deleteProviderMutation = useMutation({
    mutationFn: async (id: string) => {
      const currentConfig = await config.get();
      await config.set({
        ...currentConfig,
        providers: Object.fromEntries(
          Object.entries(currentConfig.providers || {}).filter(
            ([key]) => key !== id,
          ),
        ),
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.config.all(),
      });
    },
  });

  const resolvedProvidersConfig = useMemo(
    () => toMerged(providersConfig ?? {}, preloadedProviders),
    [providersConfig],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Providers</CardTitle>
        <CardDescription>Configure your AI providers here.</CardDescription>
      </CardHeader>
      <CardContent>
        {status === "pending" ? (
          <Spinner />
        ) : status === "error" ? (
          <div className="text-red-500">Error loading providers.</div>
        ) : Object.keys(providersConfig ?? {}).length === 0 ? (
          <div>No providers configured.</div>
        ) : (
          <ul className="space-y-2">
            {Object.keys(providersConfig ?? {}).map((providerId) => {
              const providerConfig =
                resolvedProvidersConfig[
                  providerId as keyof typeof resolvedProvidersConfig
                ];
              return (
                <li
                  key={providerId}
                  className="flex items-center justify-between rounded-md border p-4"
                >
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <ProviderIcon
                        providerId={providerId}
                        className="size-6"
                      />
                      <div className="font-medium">
                        {providerConfig.name || providerId}
                      </div>
                    </div>
                    {providerConfig.baseUrl && (
                      <div className="text-muted-foreground text-sm">
                        {providerConfig.baseUrl}
                      </div>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <UpdateProviderButton
                      providerId={providerId}
                      providerConfig={providerConfig}
                    >
                      <Pencil />
                    </UpdateProviderButton>
                    <Button
                      onClick={() => deleteProviderMutation.mutate(providerId)}
                    >
                      <Trash />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
      <CardFooter className="flex justify-end">
        <CreateProviderButton>
          <Plus />
          New
        </CreateProviderButton>
      </CardFooter>
    </Card>
  );
};
