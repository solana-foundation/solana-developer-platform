"use client";

import type { ReactNode } from "react";
import { useOptionalDashboardWorkspace } from "@/contexts/dashboard-workspace-context";

/**
 * Whether the NEW DESIGN flag is on for this dashboard request. Outside the dashboard
 * workspace (tests, the preparation screen) it is off, so main's code renders.
 */
export function useNewDesign(): boolean {
  return useOptionalDashboardWorkspace()?.flags.newDesign ?? false;
}

/**
 * Renders `current` on the new design and `legacy` otherwise; for client surfaces, such as a
 * route's loading skeleton, that exist in both designs.
 */
export function DesignSwitch({ current, legacy }: { current: ReactNode; legacy: ReactNode }) {
  return useNewDesign() ? current : legacy;
}
