import { useMutation } from "@tanstack/react-query";
import type React from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useMediaQuery } from "usehooks-ts";
import * as z from "zod";
import { useConfigInterface } from "~/hooks/use-config";
import { useConfig } from "./config";

export const Theme = z.enum(["light", "dark", "system"]).default("system");
export type Theme = z.infer<typeof Theme>;

export const ResolvedTheme = z.enum(["light", "dark"]);
export type ResolvedTheme = z.infer<typeof ResolvedTheme>;

type ThemeProviderProps = {
  children: React.ReactNode;
  defaultTheme?: Theme;
};

type ThemeProviderState = {
  theme: Theme;
  setTheme: React.Dispatch<React.SetStateAction<Theme>>;
  resolvedTheme: ResolvedTheme;
};

const ThemeProviderContext = createContext<ThemeProviderState | null>(null);

export const useStoredTheme = () => {
  const configInterface = useConfigInterface();
  const { data: config, refetch } = useConfig();
  const setMutation = useMutation({
    mutationFn: async (newTheme: Theme | null) => {
      await configInterface.merge({ theme: newTheme || undefined });
    },
    onSettled: () => {
      refetch();
    },
  });

  return {
    theme: config?.theme,
    setTheme: setMutation.mutateAsync,
    refetch,
  };
};

export function ThemeProvider({
  children,
  defaultTheme = "system",
}: ThemeProviderProps) {
  const { theme: storedTheme, setTheme: setStoredTheme } = useStoredTheme();
  const [theme, _setTheme] = useState<Theme>(storedTheme ?? defaultTheme);
  useEffect(() => {
    _setTheme(storedTheme ?? defaultTheme);
  }, [storedTheme, defaultTheme]);

  const setTheme: React.Dispatch<React.SetStateAction<Theme>> = useCallback(
    (value) => {
      let newTheme: Theme;
      if (typeof value === "function") {
        newTheme = value(theme);
      } else {
        newTheme = value;
      }
      _setTheme(newTheme);
      setStoredTheme(newTheme);
    },
    [theme, setStoredTheme],
  );

  const isDarkMode = useMediaQuery("(prefers-color-scheme: dark)");
  const resolvedTheme = useMemo(() => {
    if (theme === "system") {
      return isDarkMode ? "dark" : "light";
    }
    return theme;
  }, [theme, isDarkMode]);

  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(resolvedTheme);
  }, [resolvedTheme]);

  return (
    <ThemeProviderContext.Provider
      value={{
        theme,
        setTheme,
        resolvedTheme,
      }}
    >
      {children}
    </ThemeProviderContext.Provider>
  );
}

export function useTheme<T = ThemeProviderState>(
  selector?: (state: ThemeProviderState) => T,
) {
  const context = useContext(ThemeProviderContext);
  if (context === null) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  const value = useMemo(
    () => (selector ? selector(context) : context) as T,
    [context, selector],
  );
  return value;
}
