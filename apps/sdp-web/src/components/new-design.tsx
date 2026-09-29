"use client";

import type { ReactNode } from "react";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";

/** Whether the NEW DESIGN flag is on for this dashboard request. */
export function useNewDesign(): boolean {
  return useDashboardWorkspace().flags.newDesign;
}

/**
 * Renders `current` on the new design and `legacy` otherwise; for client surfaces, such as a
 * route's loading skeleton, that exist in both designs.
 */
export function DesignSwitch({ current, legacy }: { current: ReactNode; legacy: ReactNode }) {
  return useNewDesign() ? current : legacy;
}
