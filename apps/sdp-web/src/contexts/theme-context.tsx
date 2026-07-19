"use client";

import { ThemeProvider as NextThemeProvider, useTheme as useNextTheme } from "next-themes";
import { type ReactNode, useCallback, useMemo, useSyncExternalStore } from "react";

export type Theme = "light" | "dark";

/** localStorage key holding the user's explicit choice. */
export const THEME_STORAGE_KEY = "sdp-theme";

type ThemeContextValue = {
  theme: Theme;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
};

const subscribeToHydration = () => () => {};

export function resolveTheme(resolvedTheme: string | undefined): Theme {
  return resolvedTheme === "dark" ? "dark" : "light";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemeProvider
      attribute="class"
      defaultTheme="system"
      enableColorScheme
      enableSystem
      storageKey={THEME_STORAGE_KEY}
    >
      {children}
    </NextThemeProvider>
  );
}

export function useTheme(): ThemeContextValue {
  const { resolvedTheme, setTheme: setNextTheme, themes } = useNextTheme();
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false
  );
  const theme = hydrated ? resolveTheme(resolvedTheme) : "light";

  const setTheme = useCallback(
    (nextTheme: Theme) => {
      setNextTheme(nextTheme);
    },
    [setNextTheme]
  );

  const toggleTheme = useCallback(() => {
    setNextTheme(theme === "dark" ? "light" : "dark");
  }, [setNextTheme, theme]);

  const value = useMemo(() => ({ theme, toggleTheme, setTheme }), [setTheme, theme, toggleTheme]);

  if (themes.length === 0) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }

  return value;
}
