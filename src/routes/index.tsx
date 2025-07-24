import { createFileRoute } from "@tanstack/react-router";
import { ConversationWindow } from "~/components/chat/window";
import { SidebarProvider, SidebarTrigger } from "~/components/ui/sidebar";

export const Route = createFileRoute("/")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <SidebarProvider className="relative flex size-full">
      <SidebarTrigger />
      <ConversationWindow />
    </SidebarProvider>
  );
}
