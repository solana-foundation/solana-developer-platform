"use client";

import { DashboardQuickStart } from "@/components/dashboard-quick-start";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { selectActiveDashboardTab, useDashboardTab } from "@/lib/dashboard-url-state";
import { LeaveOrganizationSection } from "./leave-organization-section";
import { MainnetAccessSection } from "./mainnet-access-section";
import { MembersSection } from "./members-section";
import { OrganizationAccessSection } from "./organization-access-section";
import { OrganizationAlertEmailsSection } from "./organization-alert-emails-section";
import { OrganizationDetailsSection } from "./organization-details-section";
import { SETTINGS_TABS } from "./settings-tabs";

/**
 * Organization settings, as tabs that switch in the browser (`?tab=` is shallow). General: the
 * organization's name and ID, the quick start for API key managers, mainnet access and email
 * alerts for admins, and leaving for everyone else. Members, for admins: inviting and the member
 * list. Security, for admins: the API-key IP allowlist. A tab the person's role does not hold
 * falls back to General.
 */
export function SettingsWorkspace() {
  const { dashboardAccess } = useDashboardWorkspace();
  const { canManageApiKeys, canManageOrgSettings } = dashboardAccess.capabilities;
  const visibleTabs = SETTINGS_TABS.filter(
    (tab) => !("capability" in tab) || dashboardAccess.capabilities[tab.capability]
  );
  const activeTab = selectActiveDashboardTab(visibleTabs, useDashboardTab());
  switch (activeTab.id) {
    case "general":
      return (
        <div className="@container flex w-full flex-col gap-2.5">
          <OrganizationDetailsSection />
          {canManageApiKeys ? <DashboardQuickStart variant="settings" /> : null}
          {canManageOrgSettings ? <MainnetAccessSection /> : null}
          {canManageOrgSettings ? <OrganizationAlertEmailsSection /> : null}
          {/* Admins cannot leave; another admin removes them. */}
          {dashboardAccess.role !== "admin" ? <LeaveOrganizationSection /> : null}
        </div>
      );
    case "members":
      return (
        <div className="@container flex w-full flex-col gap-2.5">
          <MembersSection />
        </div>
      );
    case "security":
      return (
        <div className="@container flex w-full flex-col gap-2.5">
          <OrganizationAccessSection />
        </div>
      );
    default: {
      const exhaustive: never = activeTab;
      throw new Error(`Unhandled settings tab: ${JSON.stringify(exhaustive)}`);
    }
  }
}
