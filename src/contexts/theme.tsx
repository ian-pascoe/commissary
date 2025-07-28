import { useMutation, useQuery } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useMediaQuery } from "usehooks-ts";
import * as z from "zod";
import { useConfig } from "~/hooks/use-config";

export const Theme = z.enum(["light", "dark", "system"]).default("system");
export type Theme = z.infer<typeof Theme>;

export const ResolvedTheme = z.enum(["light", "dark"]);
export type ResolvedTheme = z.infer<typeof ResolvedTheme>;

type ThemeProviderProps = {
  children: React.ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
};

type ThemeProviderState = {
  theme: Theme;
  setTheme: React.Dispatch<React.SetStateAction<Theme>>;
  resolvedTheme: ResolvedTheme;
};

const ThemeProviderContext = createContext<ThemeProviderState | null>(null);

export const useStoredTheme = () => {
  const config = useConfig();
  const query = useQuery({
    queryKey: ["stored-theme"],
    queryFn: async () => {
      const theme = await config.get().then((c) => c.theme);
      return theme ?? null;
    },
  });
  const setMutation = useMutation({
    mutationFn: async (newTheme: Theme | null) => {
      await config.merge({ theme: newTheme || undefined });
    },
    onSettled: () => {
      query.refetch();
    },
  });

  return {
    theme: query.data,
    setTheme: setMutation.mutateAsync,
    refresh: query.refetch,
  };
};

export function ThemeProvider({
  children,
  defaultTheme = "system",
  ...props
}: ThemeProviderProps) {
  const { theme: storedTheme, setTheme: setStoredTheme } = useStoredTheme();
  const [theme, _setTheme] = useState<Theme>(defaultTheme);
  useEffect(() => {
    _setTheme(storedTheme ?? defaultTheme);
  }, [storedTheme, defaultTheme]);

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

  const value = useMemo(
    () =>
      ({
        theme,
        setTheme: (value) => {
          let newTheme: Theme;
          if (typeof value === "function") {
            newTheme = value(theme);
          } else {
            newTheme = value;
          }
          _setTheme(newTheme);
          setStoredTheme(newTheme);
        },
        resolvedTheme,
      }) satisfies ThemeProviderState,
    [theme, resolvedTheme, setStoredTheme],
  );

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

export const useTheme = () => {
  const context = useContext(ThemeProviderContext);
  if (context === null) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
};
