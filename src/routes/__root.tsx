import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { ThemeProvider } from "~/contexts/theme";
import type { initDb } from "~/lib/database";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
  db: Awaited<ReturnType<typeof initDb>>;
}>()({
  component: () => (
    <ThemeProvider>
      <Outlet />
      <TanStackRouterDevtools />
    </ThemeProvider>
  ),
});
