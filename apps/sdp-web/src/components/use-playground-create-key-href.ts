"use client";

import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useProjectHref } from "@/lib/use-dashboard-project";

/**
 * Where a playground with no API key sends someone to make one: the new-key page, for a member
 * who may manage keys, or nothing for one who may not (they need an owner to make it).
 */
export function usePlaygroundCreateKeyHref(): string | undefined {
  const { dashboardAccess } = useDashboardWorkspace();
  const projectHref = useProjectHref();
  // In this tab's project, whatever another tab has opened since.
  return dashboardAccess.capabilities.canManageApiKeys
    ? projectHref("/dashboard/api-keys/new")
    : undefined;
}
