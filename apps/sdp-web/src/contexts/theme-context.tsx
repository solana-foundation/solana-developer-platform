"use client";

import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";

export type Theme = "light" | "dark";

/** localStorage key holding the user's explicit choice (absent → follow OS). */
export const THEME_STORAGE_KEY = "sdp-theme";

type ThemeContextValue = {
  theme: Theme;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Inline, render-blocking script that applies the theme class before first
 * paint (no flash). Runs before React hydrates: reads the persisted choice,
 * else falls back to the OS `prefers-color-scheme`. Kept in sync with
 * {@link THEME_STORAGE_KEY} and the `.dark` class used by the CSS + design system.
 */
export const THEME_NO_FLASH_SCRIPT = `(function(){try{var s=localStorage.getItem('${THEME_STORAGE_KEY}');var d=s?s==='dark':window.matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.classList.toggle('dark',d);}catch(e){}})();`;

function readThemeFromDom(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Ignore storage failures (private mode, quota) — the class still applies.
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Read the class the no-flash script already applied so `theme` is correct on
  // the client's FIRST render. This matters for consumers that only theme
  // themselves at mount and don't react to later prop changes (notably Clerk's
  // widgets) — they must see the right theme immediately, not one tick later.
  // (SSR has no DOM and renders "light"; <html suppressHydrationWarning> covers
  // the resulting attribute diff, and client-rendered consumers commit the
  // correct theme on hydration.)
  const [theme, setThemeState] = useState<Theme>(readThemeFromDom);

  // Safety re-sync (e.g. the class changed between the initializer and mount).
  useEffect(() => {
    setThemeState(readThemeFromDom());
  }, []);

  const setTheme = useCallback((next: Theme) => {
    applyTheme(next);
    setThemeState(next);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((prev) => {
      const next: Theme = prev === "dark" ? "light" : "dark";
      applyTheme(next);
      return next;
    });
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (ctx === null) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return ctx;
}
