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

/** The theme actually painted on screen, after "system" has been resolved. */
export type Theme = "light" | "dark";

/** What the user picked. "system" defers to the OS and is the default. */
export type ThemePreference = "system" | Theme;

export const THEME_PREFERENCES = ["system", "light", "dark"] as const satisfies readonly [
  ThemePreference,
  ...ThemePreference[],
];

/** localStorage key holding the user's explicit choice. */
export const THEME_STORAGE_KEY = "sdp-theme";

type ThemeContextValue = {
  theme: Theme;
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
  /** False on the server and for the first client render, when no preference is knowable. */
  hydrated: boolean;
};

const ThemeProviderContext = createContext(false);

// The no-op store intentionally changes only between the server and client snapshots.
// React schedules the post-hydration render without an effect or a browser event listener.
const subscribeToHydration = () => () => {};

export function resolveTheme(resolvedTheme: string | undefined): Theme {
  return resolvedTheme === "dark" ? "dark" : "light";
}

/** Anything that is not an explicit light/dark override means the OS is in charge. */
export function resolvePreference(storedTheme: string | undefined): ThemePreference {
  return storedTheme === "light" || storedTheme === "dark" ? storedTheme : "system";
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
  const { resolvedTheme, setTheme: setNextTheme, theme: storedTheme } = useNextTheme();
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false
  );
  const theme = hydrated ? resolveTheme(resolvedTheme) : "light";
  // Before hydration the stored choice is unreadable, so callers get the default
  // rather than a guess. Gate any rendering of it on `hydrated`.
  const preference = hydrated ? resolvePreference(storedTheme) : "system";

  const setPreference = useCallback(
    (nextPreference: ThemePreference) => {
      setNextTheme(nextPreference);
    },
    [setNextTheme]
  );

  const value = useMemo(
    () => ({ theme, preference, setPreference, hydrated }),
    [hydrated, preference, setPreference, theme]
  );

  if (!hasThemeProvider) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }

  return value;
}
