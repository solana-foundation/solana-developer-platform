"use client";

import type { ReactNode } from "react";
import { useOptionalDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { type DesignModule, isDesignModuleOn } from "@/lib/design-modules";

/**
 * Whether this dashboard request renders in the new design: NEW DESIGN is on and, for a design
 * module, so is the module's own flag. Outside the dashboard workspace (tests, the preparation
 * screen) it is off, so main's code renders.
 *
 * @param designModule - The redesigned area, or none for NEW DESIGN alone.
 */
export function useNewDesign(designModule?: DesignModule): boolean {
  const flags = useOptionalDashboardWorkspace()?.flags;
  return designModule ? isDesignModuleOn(flags, designModule) : (flags?.newDesign ?? false);
}

/**
 * Renders `current` on the new design and `legacy` otherwise; for client surfaces, such as a
 * route's loading skeleton, that exist in both designs.
 */
export function DesignSwitch({
  current,
  legacy,
  designModule,
}: {
  current: ReactNode;
  legacy: ReactNode;
  /** The redesigned area the surface belongs to, or none for NEW DESIGN alone. */
  designModule?: DesignModule;
}) {
  return useNewDesign(designModule) ? current : legacy;
}
