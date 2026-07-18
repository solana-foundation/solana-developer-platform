"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
} from "react";

export type Theme = "light" | "dark";

/** localStorage key holding the user's explicit choice (absent means follow the OS). */
export const THEME_STORAGE_KEY = "sdp-theme";

type ThemeContextValue = {
  theme: Theme;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);
const themeListeners = new Set<() => void>();
let inMemoryPreference: Theme | null = null;

export function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark";
}

export function resolveTheme(preference: unknown, prefersDark: boolean): Theme {
  return isTheme(preference) ? preference : prefersDark ? "dark" : "light";
}

/**
 * Render-blocking script that applies the resolved class before the first
 * paint. Storage failures and invalid values both fall back to the OS.
 */
export const THEME_NO_FLASH_SCRIPT = `(function(){var s=null;try{s=localStorage.getItem('${THEME_STORAGE_KEY}')}catch(e){}var m=false;try{m=window.matchMedia('(prefers-color-scheme: dark)').matches}catch(e){}var d=s==='dark'||(s!=='light'&&m);document.documentElement.classList.toggle('dark',d)})();`;

function readThemeFromDom(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function getSystemTheme(media?: MediaQueryList): Theme {
  const prefersDark = media?.matches ?? window.matchMedia("(prefers-color-scheme: dark)").matches;
  return prefersDark ? "dark" : "light";
}

function readStoredPreference(): Theme | null {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (isTheme(stored)) return stored;
  } catch {
    // Keep the session-only preference when storage is unavailable.
  }
  return inMemoryPreference;
}

function applyThemeClass(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

function notifyThemeListeners() {
  for (const listener of themeListeners) listener();
}

function applyResolvedTheme(theme: Theme) {
  if (readThemeFromDom() === theme) return;
  applyThemeClass(theme);
  notifyThemeListeners();
}

function persistTheme(theme: Theme) {
  inMemoryPreference = theme;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // The explicit choice still lasts for this page session.
  }
}

function subscribeToTheme(listener: () => void): () => void {
  themeListeners.add(listener);
  const media = window.matchMedia("(prefers-color-scheme: dark)");

  const handleSystemThemeChange = () => {
    if (readStoredPreference() === null) {
      applyResolvedTheme(getSystemTheme(media));
    }
  };

  const handleStorage = (event: StorageEvent) => {
    if (event.key !== THEME_STORAGE_KEY) return;
    inMemoryPreference = isTheme(event.newValue) ? event.newValue : null;
    applyResolvedTheme(resolveTheme(event.newValue, media.matches));
  };

  media.addEventListener("change", handleSystemThemeChange);
  window.addEventListener("storage", handleStorage);

  return () => {
    themeListeners.delete(listener);
    media.removeEventListener("change", handleSystemThemeChange);
    window.removeEventListener("storage", handleStorage);
  };
}

function getServerThemeSnapshot(): Theme {
  return "light";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useSyncExternalStore(subscribeToTheme, readThemeFromDom, getServerThemeSnapshot);

  const setTheme = useCallback((next: Theme) => {
    persistTheme(next);
    applyResolvedTheme(next);
  }, []);

  const toggleTheme = useCallback(() => {
    const next = readThemeFromDom() === "dark" ? "light" : "dark";
    persistTheme(next);
    applyResolvedTheme(next);
  }, []);

  const value = useMemo(() => ({ theme, toggleTheme, setTheme }), [setTheme, theme, toggleTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (context === null) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
