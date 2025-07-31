import { AuthQueryProvider } from "@daveyplate/better-auth-tanstack";
import { AuthUIProviderTanstack } from "@daveyplate/better-auth-ui/tanstack";
import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  Link,
  Outlet,
  useRouter,
} from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { Toaster } from "~/components/ui/sonner";
import { ThemeProvider } from "~/contexts/theme";
import type { ApiClient } from "~/lib/api";
import type { AuthClient } from "~/lib/auth";
import type { ConfigInterface } from "~/lib/config";
import type { LocalDatabase } from "~/lib/database";
import type { StrongholdInterface } from "~/lib/stronghold";
import type { User } from "~/schemas/user";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
  localDb: LocalDatabase;
  config: ConfigInterface;
  stronghold: StrongholdInterface;
  authClient: AuthClient;
  apiClient: ApiClient;
}>()({
  wrapInSuspense: true,
  staleTime: Infinity,
  beforeLoad: async ({ context: { authClient } }) => {
    const { data: session } = await authClient.getSession();
    return {
      user: session?.user as User | undefined,
    };
  },
  component: () => {
    const router = useRouter();
    const authClient = Route.useRouteContext({
      select: (ctx) => ctx.authClient,
    });

    return (
      <ThemeProvider>
        <AuthQueryProvider>
          <AuthUIProviderTanstack
            authClient={authClient}
            navigate={(href) => router.navigate({ to: href })}
            replace={(href) => router.navigate({ to: href, replace: true })}
            onSessionChange={() => router.invalidate()}
            settings={{ url: "/settings" }}
            Link={({ href, ...props }) => <Link to={href} {...props} />}
          >
            <Outlet />
            <Toaster />
            <TanStackRouterDevtools position="top-right" />
          </AuthUIProviderTanstack>
        </AuthQueryProvider>
      </ThemeProvider>
    );
  },
});
