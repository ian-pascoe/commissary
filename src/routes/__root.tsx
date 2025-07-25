import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import { initApiClient } from "~/lib/api";
import { initAuthClient } from "~/lib/auth";
import { initLocalDb } from "~/lib/database";
import { initStore } from "~/lib/store";
import { initStronghold } from "~/lib/stronghold";
import type { User } from "~/schemas/user";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  wrapInSuspense: true,
  beforeLoad: async () => {
    const [db, store, { stronghold, authClient, user, apiClient }] =
      await Promise.all([
        initLocalDb(),
        initStore(),
        initStronghold().then(async (stronghold) => {
          const authClient = initAuthClient(stronghold.store);
          let user: User | undefined;

          const { data: session } = await authClient.getSession();
          if (session) {
            user = session.user as User | undefined;
          } else {
            const { error } = await authClient.signIn.anonymous();
            if (error) {
              throw new Error(
                `Failed to sign in anonymously: ${error.message}`,
              );
            }
            const { data: newSession } = await authClient.getSession();
            user = newSession?.user as User | undefined;
          }

          return {
            stronghold,
            authClient,
            user,
            apiClient: initApiClient(stronghold.store),
          };
        }),
      ]);
    return {
      db,
      store,
      stronghold,
      authClient,
      user,
      apiClient,
    };
  },
  component: () => (
    <>
      <Outlet />
      {/* <TanStackRouterDevtools position="top-right" /> */}
    </>
  ),
});
