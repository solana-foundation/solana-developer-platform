"use client";

import { Tab, TabList, Tabs } from "@solana/design-system/tabs";
import { useDashboardRouter } from "@/lib/use-dashboard-router";

export interface PolicyAuditDetailTabItem {
  id: string;
  label: string;
  href: string;
}

/**
 * The audit detail's tab row rendered with the design-system tabs. Each tab is
 * a server-routed destination (the active tab renders on the server), so
 * selecting one navigates to its prebuilt href instead of toggling local state.
 *
 * @param props.tabs - Tab options with their target hrefs, in display order.
 * @param props.activeTab - Id of the tab the current URL renders.
 * @returns The tab list.
 */
export function PolicyAuditDetailTabs({
  tabs,
  activeTab,
}: {
  tabs: readonly PolicyAuditDetailTabItem[];
  activeTab: string;
}) {
  const router = useDashboardRouter();

  return (
    <Tabs
      bordered
      value={activeTab}
      onValueChange={(value) => {
        const next = tabs.find((tab) => tab.id === value);
        if (next) router.push(next.href);
      }}
    >
      <TabList>
        {tabs.map((tab) => (
          <Tab key={tab.id} value={tab.id}>
            {tab.label}
          </Tab>
        ))}
      </TabList>
    </Tabs>
  );
}
