"use client";

import { REFRESH_THEME_ATTRIBUTE, type REFRESH_THEME_VALUE } from "@sdp/design-tokens";
import { createContext, useContext } from "react";

export type ThemeScope = typeof REFRESH_THEME_VALUE;

/**
 * Names the design-token theme scope for everything below its provider (see
 * `ThemeScopeProvider` in theme-scope-provider.tsx). The element that carries the scope
 * attribute sets it itself (see {@link themeScopeAttributes}); this context exists for what
 * renders outside that element: portaled popovers, menus and modals read it and stamp the same
 * attribute on their own root, so they theme like the page that opened them.
 */
export const ThemeScopeContext = createContext<ThemeScope | null>(null);

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
