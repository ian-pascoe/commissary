import {
  InvalidAccessTokenError,
  InvalidRefreshTokenError,
} from "@openauthjs/openauth/error";
import { useNavigate } from "@tanstack/react-router";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { useAuthClient } from "~/hooks/use-auth-client";
import { useStrongholdStore } from "~/hooks/use-stronghold";
import type { User } from "~/schemas/user";

type AuthContextType = {
  login: () => Promise<void>;
  logout: () => Promise<void>;
  refreshTokens: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType | null>(null);

export type AuthProviderProps = {
  children: ReactNode;
};

export function AuthProvider({ children }: AuthProviderProps) {
  const client = useAuthClient();
  const store = useStrongholdStore();
  const navigate = useNavigate();
  
  const [user, setUser] = useState<User | null | undefined>(undefined);

  const login = useCallback(async () => {
    const redirectUrl = import.meta.env.DEV
      ? "http://localhost:3000/auth/callback"
      : "com.spiritledsoftware.commissary://auth/callback";
    const { challenge, url } = await client.authorize(redirectUrl, "code", {
      pkce: true,
    });
    await store.set("challenge", JSON.stringify(challenge));

    if (import.meta.env.DEV) {
      window.location.href = url;
    } else {
      await openUrl(url);
    }
  }, [client, store]);

  const logout = useCallback(async () => {
    await Promise.all([
      store.remove("access-token"),
      store.remove("refresh-token"),
      store.remove("challenge"),
    ]);
    await navigate({ to: "/" });
  }, [store, navigate]);

  const refreshTokens = useCallback(async () => {
    const [token, refresh] = await Promise.all([
      store.get("access-token"),
      store.get("refresh-token"),
    ]);
    if (!token || !refresh) return;
    const next = await client.refresh(refresh, {
      access: token,
    });
    if (next.err) {
      if (
        next.err instanceof InvalidAccessTokenError ||
        next.err instanceof InvalidRefreshTokenError
      ) {
        await logout();
      }
      return;
    }

    if (!next.tokens) return;

    await Promise.all([
      store.set("access-token", next.tokens.access),
      store.set("refresh-token", next.tokens.refresh),
    ]);
  }, [store, client, logout]);

  const value = useMemo(
    () => ({
      login,
      logout,
      refreshTokens,
    }),
    [login, logout, refreshTokens],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (ctx === null) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
