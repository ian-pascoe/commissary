import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import { ThemeProvider } from "~/contexts/theme";
import type { ApiClient } from "~/lib/api";
import type { AuthClient } from "~/lib/auth";
import type { ConfigInterface } from "~/lib/config";
import type { LocalDatabase } from "~/lib/database";
import type { GeneralStore } from "~/lib/general-store";
import type { StrongholdInterface } from "~/lib/stronghold";
import type { User } from "~/schemas/user";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
  db: LocalDatabase;
  config: ConfigInterface;
  generalStore: GeneralStore;
  stronghold: StrongholdInterface;
  authClient: AuthClient;
  apiClient: ApiClient;
}>()({
  wrapInSuspense: true,
  staleTime: Infinity,
  beforeLoad: async ({ context: { authClient } }) => {
    let user: User | undefined;
    const { data: session } = await authClient.getSession();
    if (session) {
      user = session.user as User | undefined;
    } else {
      const { error } = await authClient.signIn.anonymous();
      if (error) {
        throw new Error(`Failed to sign in anonymously: ${error.message}`);
      }
      const { data: newSession } = await authClient.getSession();
      user = newSession?.user as User | undefined;
    }

    return {
      user,
    };
  },
  component: () => (
    <ThemeProvider>
      <Outlet />
      {/* <TanStackRouterDevtools position="top-right" /> */}
    </ThemeProvider>
  ),
});
