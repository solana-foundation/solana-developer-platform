"use client";

import type { ReactNode } from "react";
import { type ThemeScope, ThemeScopeContext } from "@/components/theme-scope";

/**
 * Names the design-token theme scope for everything below it. Kept apart from the hooks in
 * theme-scope.ts so this file exports only a component and Fast Refresh can keep its state.
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
