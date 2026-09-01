"use client";

import { Tab, TabList, Tabs } from "@solana/design-system/tabs";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "@/i18n/provider";
import { replaceDashboardSearchParams } from "@/lib/dashboard-url-state";
import {
  PRIVATE_CHANNELS_INTEGRATION_PATH,
  PRIVATE_CHANNELS_OVERVIEW_PATH,
  PRIVATE_CHANNELS_SETUP_PATH,
} from "./private-channels-routes";

// Adding a new sub-page (transfers, channels, identities, …):
//   1. Create app/dashboard/integrations/private-channels/<slug>/page.tsx
//   2. Append { id, labelKey, href, requiresActive: true } to the list.
//
// Overview and API Playground are always visible, including before an instance
// is connected — and they are two panes of the same Overview route, switched by
// the shallow `?tab=` contract (see DashboardHeaderTabs) so toggling them never
// refetches an RSC payload. There is no Instance or Channels tab: the instance
// (connect/disconnect) and channels are reached from links in the Overview's
// Connected-instance card. The Events feed has no tab either — it's reached
// from the Overview's "All activity" link.

/** The Overview route's `?tab=` value for its playground pane. */
const PLAYGROUND_TAB = "playground";

const TABS = [
  {
    id: "overview",
    labelKey: "DashboardPrivateChannels.tabs.overview",
    href: PRIVATE_CHANNELS_OVERVIEW_PATH,
    requiresActive: false,
  },
  {
    id: "members",
    labelKey: "DashboardPrivateChannels.tabs.members",
    href: "/dashboard/integrations/private-channels/members",
    requiresActive: true,
  },
  {
    id: "deposit",
    labelKey: "DashboardPrivateChannels.tabs.deposit",
    href: "/dashboard/integrations/private-channels/deposit",
    requiresActive: true,
  },
  {
    id: "transfer",
    labelKey: "DashboardPrivateChannels.tabs.transfer",
    href: "/dashboard/integrations/private-channels/transfer",
    requiresActive: true,
  },
  {
    id: "withdraw",
    labelKey: "DashboardPrivateChannels.tabs.withdraw",
    href: "/dashboard/integrations/private-channels/withdraw",
    requiresActive: true,
  },
  {
    id: "api-playground",
    labelKey: "DashboardPrivateChannels.tabs.apiPlayground",
    href: `${PRIVATE_CHANNELS_OVERVIEW_PATH}?tab=${PLAYGROUND_TAB}`,
    // Always visible: the /instance endpoints are what the operator needs
    // before an instance is connected.
    requiresActive: false,
  },
] as const;

interface Props {
  isConnected: boolean;
}

export function PrivateChannelsHeaderTabs({ isConnected }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  // Router state, not `useDashboardTab`: its window snapshot is only re-read
  // after the commit, so a cross-route push landing here with `?tab=` preset
  // (e.g. Identities → API Playground) would paint one frame with Overview
  // highlighted. Router-provided search params are correct at render time and
  // stay in sync with the shallow history writes below, which Next patches.
  const urlTab = useSearchParams().get("tab");
  const t = useTranslations();

  // The provider detail and dedicated setup flow use the Integrations pattern;
  // the existing workspace tabs resume once the operator opens a current tool.
  if (pathname === PRIVATE_CHANNELS_INTEGRATION_PATH || pathname === PRIVATE_CHANNELS_SETUP_PATH) {
    return null;
  }

  // Keep the always-visible destinations available before an instance is connected.
  const visible = TABS.filter((tab) => isConnected || !tab.requiresActive);
  if (visible.length === 0) return null;

  const onOverviewRoute = pathname.startsWith(PRIVATE_CHANNELS_OVERVIEW_PATH);
  const activeId = onOverviewRoute
    ? urlTab === PLAYGROUND_TAB
      ? "api-playground"
      : "overview"
    : (visible.find((tab) => pathname.startsWith(tab.href))?.id ?? visible[0].id);

  return (
    <Tabs
      bordered
      value={activeId}
      onValueChange={(value) => {
        const next = visible.find((tab) => tab.id === value);
        if (!next) return;
        if (onOverviewRoute && (value === "overview" || value === "api-playground")) {
          // Both panes live on the Overview route — swap them shallowly.
          replaceDashboardSearchParams({
            tab: value === "api-playground" ? PLAYGROUND_TAB : null,
          });
          return;
        }
        router.push(next.href);
      }}
    >
      <TabList>
        {visible.map((tab) => (
          <Tab key={tab.id} value={tab.id}>
            {t(tab.labelKey)}
          </Tab>
        ))}
      </TabList>
    </Tabs>
  );
}
