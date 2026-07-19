"use client";

import { ThemeProvider as NextThemeProvider, useTheme as useNextTheme } from "next-themes";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
} from "react";

export type Theme = "light" | "dark";

/** localStorage key holding the user's explicit choice. */
export const THEME_STORAGE_KEY = "sdp-theme";

type ThemeContextValue = {
  theme: Theme;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
};

const ThemeProviderContext = createContext(false);

// The no-op store intentionally changes only between the server and client snapshots.
// React schedules the post-hydration render without an effect or a browser event listener.
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
      <ThemeProviderContext.Provider value>{children}</ThemeProviderContext.Provider>
    </NextThemeProvider>
  );
}

export function useTheme(): ThemeContextValue {
  const hasThemeProvider = useContext(ThemeProviderContext);
  const { resolvedTheme, setTheme: setNextTheme } = useNextTheme();
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

  if (!hasThemeProvider) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }

  return value;
}
