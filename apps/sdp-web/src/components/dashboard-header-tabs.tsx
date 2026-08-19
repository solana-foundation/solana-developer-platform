"use client";

import { Tab, TabList, Tabs } from "@solana/design-system/tabs";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  selectActiveDashboardTab,
  useDashboardTab,
  useDashboardUrlState,
} from "@/lib/dashboard-url-state";

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

const EMPTY_HEADER_TAB_COUNTS: Record<string, number> = {};

let headerTabCounts = EMPTY_HEADER_TAB_COUNTS;
const headerTabCountListeners = new Set<() => void>();

function subscribeToHeaderTabCounts(onStoreChange: () => void) {
  headerTabCountListeners.add(onStoreChange);
  return () => {
    headerTabCountListeners.delete(onStoreChange);
  };
}

function setHeaderTabCount(tabId: string, count: number | undefined) {
  if (count === undefined) {
    if (!(tabId in headerTabCounts)) {
      return;
    }
    headerTabCounts = Object.fromEntries(
      Object.entries(headerTabCounts).filter(([id]) => id !== tabId)
    );
  } else {
    if (headerTabCounts[tabId] === count) {
      return;
    }
    headerTabCounts = { ...headerTabCounts, [tabId]: count };
  }
  for (const listener of headerTabCountListeners) {
    listener();
  }
}

/**
 * Publishes a live count onto the route's header tab with the given id, for
 * `DashboardHeaderTabs` to render beside the tab's configured label. The
 * workspace that owns the data calls this; any tab id declared in the route's
 * `headerTabs` config can carry one. A module-scoped store rather than the
 * workspace context, so a count change re-renders only the tab strip.
 *
 * @param tabId - The header tab id from the route's `headerTabs` config.
 * @param count - The count to show, or undefined to show the bare label — the
 * in-flight state, so a loading read never renders as a zero. The entry also
 * clears on unmount, so a count never outlives the workspace that published it.
 */
export function useHeaderTabCount(tabId: string, count: number | undefined): void {
  useEffect(() => {
    setHeaderTabCount(tabId, count);
    return () => setHeaderTabCount(tabId, undefined);
  }, [tabId, count]);
}

function useHeaderTabCounts(): Record<string, number> {
  return useSyncExternalStore(
    subscribeToHeaderTabCounts,
    () => headerTabCounts,
    () => EMPTY_HEADER_TAB_COUNTS
  );
}

/**
 * The route's tab set rendered in the dashboard header nav row, as declared by
 * the page config's `headerTabs`. Tab state lives in the `?tab=` search param
 * and switches shallowly (no RSC refetch) — workspaces re-render off the same
 * URL state and manage their own data refresh. Switching tabs clears the
 * `?page=` param so paginated lists restart on page 1.
 *
 * A tab whose id has a count published through `useHeaderTabCount` renders it
 * beside the configured label ("Active (3)"); with none published the label
 * renders bare, which is also the loading state of a count-carrying tab.
 *
 * @param props - The route's header tab configuration.
 * @returns The header tab list, or null on mobile viewports when hidden there.
 */
export function DashboardHeaderTabs({ tabs, hideOnMobile }: DashboardHeaderTabsConfig) {
  const { replaceSearchParams } = useDashboardUrlState();
  const headerTabCountByTabId = useHeaderTabCounts();
  const [isMobile, setIsMobile] = useState(false);
  const urlTab = useDashboardTab();
  const defaultTabId = tabs[0].id;
  const activeTab = selectActiveDashboardTab(tabs, urlTab).id;

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
            {tab.id in headerTabCountByTabId
              ? `${tab.label} (${headerTabCountByTabId[tab.id]})`
              : tab.label}
          </Tab>
        ))}
      </TabList>
    </Tabs>
  );
}
