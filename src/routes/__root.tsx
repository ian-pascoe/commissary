import type { Client as AuthClient } from "@openauthjs/openauth/client";
import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { AuthProvider } from "~/contexts/auth";
import { initDb } from "~/lib/database";
import { initStronghold } from "~/lib/stronghold";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
  authClient: AuthClient;
}>()({
  wrapInSuspense: true,
  beforeLoad: async () => {
    return {
      db: await initDb(),
      stronghold: await initStronghold(),
    };
  },
  component: () => (
    <AuthProvider>
      <Outlet />
      <TanStackRouterDevtools />
    </AuthProvider>
  ),
});
