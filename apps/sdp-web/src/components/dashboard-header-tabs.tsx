"use client";

import { Tab, TabList, Tabs } from "@solana/design-system/tabs";
import { useEffect, useState } from "react";
import { useDashboardTab, useDashboardUrlState } from "@/lib/dashboard-url-state";

export interface DashboardHeaderTabsConfig {
  /** Tab options in display order; the first tab is the default (no `?tab=` param). */
  tabs: readonly { id: string; label: string }[];
  /**
   * Hide the tab list on mobile viewports and snap back to the default tab.
   * Used by the Overview / API Playground pair, where the playground is
   * unavailable on small screens; content tab sets keep their tabs visible.
   */
  hideOnMobile: boolean;
}

/**
 * The route's tab set rendered in the dashboard header nav row, as declared by
 * the page config's `headerTabs`. Tab state lives in the `?tab=` search param
 * and switches shallowly (no RSC refetch) — workspaces re-render off the same
 * URL state and manage their own data refresh. Switching tabs clears the
 * `?page=` param so paginated lists restart on page 1.
 *
 * @param props - The route's header tab configuration.
 * @returns The header tab list, or null on mobile viewports when hidden there.
 */
export function DashboardHeaderTabs({ tabs, hideOnMobile }: DashboardHeaderTabsConfig) {
  const { replaceSearchParams } = useDashboardUrlState();
  const [isMobile, setIsMobile] = useState(false);
  const urlTab = useDashboardTab();
  const defaultTabId = tabs[0].id;
  const activeTab =
    urlTab !== null && tabs.some((tab) => tab.id === urlTab) ? urlTab : defaultTabId;

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 767px)");
    const updateIsMobile = () => setIsMobile(mediaQuery.matches);

    updateIsMobile();
    mediaQuery.addEventListener("change", updateIsMobile);

    return () => mediaQuery.removeEventListener("change", updateIsMobile);
  }, []);

  useEffect(() => {
    if (hideOnMobile && isMobile && activeTab !== defaultTabId) {
      replaceSearchParams({ tab: null, page: null });
    }
  }, [hideOnMobile, isMobile, activeTab, defaultTabId, replaceSearchParams]);

  if (hideOnMobile && isMobile) {
    return null;
  }

  return (
    <Tabs
      bordered={false}
      value={activeTab}
      onValueChange={(value) => {
        replaceSearchParams({ tab: value === defaultTabId ? null : value, page: null });
      }}
    >
      <TabList className="[&>span]:![translate:var(--active-tab-left)_0] [&>span]:!w-[var(--active-tab-width)]">
        {tabs.map((tab) => (
          <Tab key={tab.id} value={tab.id}>
            {tab.label}
          </Tab>
        ))}
      </TabList>
    </Tabs>
  );
}
