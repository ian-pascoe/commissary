import { createFileRoute, Outlet } from "@tanstack/react-router";
import { Menu } from "lucide-react";
import { ConversationsSidebar } from "~/components/conversation/sidebar";
import { ThemeToggle } from "~/components/theme/toggle";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "~/components/ui/sidebar";

export const Route = createFileRoute("/_chat")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <SidebarProvider className="relative flex size-full">
      <ConversationsSidebar />
      <SidebarInset>
        <SidebarTrigger
          variant="default"
          className="absolute top-4 left-4 z-10"
        >
          <Menu />
        </SidebarTrigger>
        <ThemeToggle
          variant="default"
          className="absolute top-4 right-4 z-10"
        />
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  );
}
