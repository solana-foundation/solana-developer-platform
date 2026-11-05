"use client";

import type { ReactNode } from "react";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { selectActiveDashboardTab, useDashboardTab } from "@/lib/dashboard-url-state";
import { SETTINGS_TABS } from "./settings-tabs";

/**
 * The tabs switch in the browser (`?tab=` is shallow), so the server renders every panel the
 * person may see and this picks one. A tab the person's role does not hold falls back to General.
 */
export function SettingsWorkspace({
  general,
  members,
  security,
}: {
  general: ReactNode;
  members: ReactNode;
  security: ReactNode;
}) {
  const { dashboardAccess } = useDashboardWorkspace();
  const visibleTabs = SETTINGS_TABS.filter(
    (tab) => !("capability" in tab) || dashboardAccess.capabilities[tab.capability]
  );
  const activeTab = selectActiveDashboardTab(visibleTabs, useDashboardTab());
  switch (activeTab.id) {
    case "general":
      return general;
    case "members":
      return members;
    case "security":
      return security;
    default: {
      const exhaustive: never = activeTab;
      throw new Error(`Unhandled settings tab: ${JSON.stringify(exhaustive)}`);
    }
  }
}
