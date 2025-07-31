import { createFileRoute, Outlet } from "@tanstack/react-router";
import { ConversationsSidebar } from "~/components/conversation/sidebar";
import { SidebarInset, SidebarProvider } from "~/components/ui/sidebar";

export const Route = createFileRoute("/_chat")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <SidebarProvider className="relative flex size-full">
      <ConversationsSidebar />
      <SidebarInset>
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  );
}
