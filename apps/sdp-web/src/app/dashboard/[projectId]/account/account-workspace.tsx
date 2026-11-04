"use client";

import { AccountPreferences } from "@/app/dashboard/[projectId]/account/account-preferences";
import { AccountProfile } from "@/app/dashboard/[projectId]/account/account-profile";
import { AccountSecurity } from "@/app/dashboard/[projectId]/account/account-security";
import { ACCOUNT_TABS } from "@/app/dashboard/[projectId]/account/account-tabs";
import { selectActiveDashboardTab, useDashboardTab } from "@/lib/dashboard-url-state";

export function AccountWorkspace() {
  const activeTab = selectActiveDashboardTab(ACCOUNT_TABS, useDashboardTab());
  switch (activeTab.id) {
    case "profile":
      return <AccountProfile />;
    case "security":
      return <AccountSecurity />;
    case "preferences":
      return <AccountPreferences />;
    default: {
      const exhaustive: never = activeTab;
      throw new Error(`Unhandled account tab: ${JSON.stringify(exhaustive)}`);
    }
  }
}
