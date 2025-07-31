import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import type { Session } from "better-auth";
import { queryKeys } from "~/lib/query-keys";
import type { User } from "~/schemas/user";

export const useAuthClient = () => {
  const authClient = useRouteContext({
    from: "__root__",
    select: (s) => s.authClient,
  });
  return authClient;
};

export type UseAuthReturnType =
  | {
      // Loading state
      status: "pending";
    }
  | {
      // Signed in state
      status: "signed-in";
      session: { user: User; session: Session };
    }
  | {
      // Signed out state
      status: "signed-out";
    }
  | {
      // Error state
      status: "error";
      error: Error;
    };

export const useAuth = (): UseAuthReturnType => {
  const authClient = useAuthClient();
  const query = useQuery({
    queryKey: queryKeys.session,
    queryFn: async () => {
      const { data: session, error } = await authClient.getSession();
      if (error) {
        throw error;
      }
      if (session) {
        return {
          ...session,
          user: session.user as User,
        };
      }
      return null;
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
  });

  if (query.status === "pending") {
    return { status: "pending" };
  }

  if (query.status === "error") {
    return {
      status: "error",
      error: query.error,
    };
  }

  if (query.status === "success") {
    if (query.data) {
      return {
        status: "signed-in",
        session: query.data,
      };
    }
  }

  return { status: "signed-out" };
};

export const useUser = () => {
  const auth = useAuth();
  if (auth.status === "signed-in") {
    return auth.session.user;
  }
  return undefined;
};

export const useSession = () => {
  const auth = useAuth();
  if (auth.status === "signed-in") {
    return auth.session.session;
  }
  return undefined;
};
