import { createFileRoute, useRouter } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { ProviderSettingsCard } from "~/components/provider/settings-card";
import { Button } from "~/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";

export const Route = createFileRoute("/settings")({
  component: RouteComponent,
});

function RouteComponent() {
  const router = useRouter();

  return (
    <div className="relative flex size-full justify-center p-5">
      <Button
        variant="outline"
        className="absolute top-4 left-4"
        onClick={() =>
          router.history.canGoBack()
            ? router.history.back()
            : router.navigate({ to: "/chat" })
        }
      >
        <ChevronLeft size={16} />
        Back
      </Button>
      <Tabs
        defaultValue="providers"
        className="size-full items-center justify-center"
      >
        <TabsList>
          <TabsTrigger value="providers">Providers</TabsTrigger>
        </TabsList>
        <TabsContent value="providers" className="w-full max-w-3xl p-4">
          <ProviderSettingsCard />
        </TabsContent>
      </Tabs>
    </div>
  );
}
