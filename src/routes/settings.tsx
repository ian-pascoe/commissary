import { createFileRoute, useRouter } from "@tanstack/react-router";
import { openPath } from "@tauri-apps/plugin-opener";
import { ArrowUpRightFromSquare, ChevronLeft } from "lucide-react";
import { McpSettingsCard } from "~/components/mcp/settings-card";
import { ProviderSettingsCard } from "~/components/provider/settings-card";
import { Button } from "~/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { config } from "~/lib/config";

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
      <Button
        variant="outline"
        className="absolute top-4 right-4"
        onClick={async () => await openPath(config.path)}
      >
        View file
        <ArrowUpRightFromSquare />
      </Button>
      <Tabs
        defaultValue="providers"
        className="size-full items-center justify-center"
      >
        <TabsList>
          <TabsTrigger value="providers">Providers</TabsTrigger>
          <TabsTrigger value="mcp">MCP</TabsTrigger>
        </TabsList>
        <TabsContent value="providers" className="w-full max-w-3xl p-4">
          <ProviderSettingsCard />
        </TabsContent>
        <TabsContent value="mcp" className="w-full max-w-3xl p-4">
          <McpSettingsCard />
        </TabsContent>
      </Tabs>
    </div>
  );
}
