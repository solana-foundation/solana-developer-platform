"use client";

import { REFRESH_THEME_ATTRIBUTE, type REFRESH_THEME_VALUE } from "@sdp/design-tokens";
import { createContext, type ReactNode, useContext } from "react";

export type ThemeScope = typeof REFRESH_THEME_VALUE;

const ThemeScopeContext = createContext<ThemeScope | null>(null);

/**
 * Names the design-token theme scope for everything below it. The element that carries the
 * scope attribute sets it itself (see {@link themeScopeAttributes}); this context exists for
 * what renders outside that element: portaled popovers, menus and modals read it and stamp
 * the same attribute on their own root, so they theme like the page that opened them.
 */
export function ThemeScopeProvider({
  scope,
  children,
}: {
  scope: ThemeScope | null;
  children: ReactNode;
}) {
  return <ThemeScopeContext.Provider value={scope}>{children}</ThemeScopeContext.Provider>;
}

export function useThemeScope(): ThemeScope | null {
  return useContext(ThemeScopeContext);
}

/** Attributes that put an element in `scope`; spreads to nothing without one. */
export function themeScopeAttributes(scope: ThemeScope | null): Record<string, string> {
  return scope ? { [REFRESH_THEME_ATTRIBUTE]: scope } : {};
}

/** Attributes for a portaled root, so it themes like the surface that opened it. */
export function useThemeScopeAttributes(): Record<string, string> {
  return themeScopeAttributes(useThemeScope());
}
