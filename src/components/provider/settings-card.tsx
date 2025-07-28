import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash } from "lucide-react";
import { useConfig } from "~/hooks/use-config";
import { useProviders } from "~/hooks/use-providers";
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
import { AddProviderButton } from "./add-button";

export const ProviderSettingsCard = () => {
  const config = useConfig();
  const queryClient = useQueryClient();
  const { providers, status } = useProviders();

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
      queryClient.invalidateQueries({ queryKey: ["providers"] });
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
              Object.entries(providers).map(([key, provider]) => (
                <li
                  key={key}
                  className="flex items-center justify-between rounded-md border p-4"
                >
                  <div className="flex flex-col">
                    <div className="font-medium">{provider.name || key}</div>
                    {provider.baseUrl && (
                      <div className="text-muted-foreground text-sm">
                        {provider.baseUrl}
                      </div>
                    )}
                  </div>
                  <Button onClick={() => deleteProviderMutation.mutate(key)}>
                    <Trash />
                  </Button>
                </li>
              ))}
          </ul>
        )}
      </CardContent>
      <CardFooter className="flex justify-end">
        <AddProviderButton>
          <Plus />
          New
        </AddProviderButton>
      </CardFooter>
    </Card>
  );
};
