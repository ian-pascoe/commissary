import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash } from "lucide-react";
import { useConfig } from "~/hooks/use-config";
import { useProvidersConfig } from "~/hooks/use-providers";
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
import { UpdateProviderButton } from "./update-button";

export const ProviderSettingsCard = () => {
  const config = useConfig();
  const queryClient = useQueryClient();
  const { data: providers, status } = useProvidersConfig();

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
        queryKey: queryKeys.config.providers.all(),
      });
    },
  });

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
        ) : providers && Object.keys(providers).length === 0 ? (
          <div>No providers configured.</div>
        ) : (
          <ul className="space-y-2">
            {providers &&
              Object.entries(providers).map(([key, providerConfig]) => (
                <li
                  key={key}
                  className="flex items-center justify-between rounded-md border p-4"
                >
                  <div className="flex flex-col">
                    <div className="font-medium">
                      {providerConfig.name || key}
                    </div>
                    {providerConfig.baseUrl && (
                      <div className="text-muted-foreground text-sm">
                        {providerConfig.baseUrl}
                      </div>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <UpdateProviderButton
                      providerId={key}
                      providerConfig={providerConfig}
                    >
                      <Pencil />
                    </UpdateProviderButton>
                    <Button onClick={() => deleteProviderMutation.mutate(key)}>
                      <Trash />
                    </Button>
                  </div>
                </li>
              ))}
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
