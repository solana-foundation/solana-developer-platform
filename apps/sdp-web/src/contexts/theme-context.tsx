"use client";

import { usePathname } from "next/navigation";
import {
  ThemeProvider as NextThemeProvider,
  type ThemeProviderProps as NextThemeProviderProps,
  useTheme as useNextTheme,
} from "next-themes";
import {
  type ComponentType,
  createContext,
  type PropsWithChildren,
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
const NextThemeProviderWithChildren = NextThemeProvider as ComponentType<
  PropsWithChildren<NextThemeProviderProps>
>;

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

/**
 * Pages that always paint in one theme, whatever the visitor chose; their
 * choice still applies everywhere else and is left untouched. The homepage
 * keeps every one of its dark styles, so deleting "/" here is the whole of
 * letting it follow the theme again.
 */
const FORCED_THEMES: Readonly<Record<string, Theme>> = { "/": "light" };

export function forcedThemeFor(pathname: string | null): Theme | undefined {
  return pathname ? FORCED_THEMES[pathname] : undefined;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Read on the client, not in the root layout: the layout does not re-render on client
  // navigation, so a lock set there would follow the visitor off the page.
  const forcedTheme = forcedThemeFor(usePathname());
  return (
    <NextThemeProviderWithChildren
      attribute="class"
      defaultTheme="system"
      enableColorScheme
      enableSystem
      forcedTheme={forcedTheme}
      storageKey={THEME_STORAGE_KEY}
    >
      <ThemeProviderContext.Provider value>{children}</ThemeProviderContext.Provider>
    </NextThemeProviderWithChildren>
  );
}

export function useTheme(): ThemeContextValue {
  const hasThemeProvider = useContext(ThemeProviderContext);
  const { forcedTheme, resolvedTheme, setTheme: setNextTheme, theme: storedTheme } = useNextTheme();
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false
  );
  // next-themes' resolvedTheme ignores a forced theme; what is painted is the forced one.
  const theme = hydrated ? resolveTheme(forcedTheme ?? resolvedTheme) : "light";
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
