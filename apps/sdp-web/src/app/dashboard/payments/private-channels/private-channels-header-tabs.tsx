"use client";

import { Tab, TabList, Tabs } from "@solana/design-system/tabs";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "@/i18n/provider";

// Adding a new sub-page (transfers, channels, members, …):
//   1. Create app/dashboard/payments/private-channels/<slug>/page.tsx
//   2. Append { id, labelKey, href, requiresActive: true } to the list.
//
// Overview is always visible (even when no instance is connected — it surfaces the
// "Not connected" state and a connect link). There is no Instance or Channels tab:
// the instance (connect/disconnect) and channels are reached from links in the
// Overview's Connected-instance card. The Events feed has no tab either — it's
// reached from the Overview's "All activity" link.
const TABS = [
  {
    id: "overview",
    labelKey: "DashboardPrivateChannels.tabs.overview",
    href: "/dashboard/payments/private-channels/overview",
    requiresActive: false,
  },
  {
    id: "members",
    labelKey: "DashboardPrivateChannels.tabs.members",
    href: "/dashboard/payments/private-channels/members",
    requiresActive: true,
  },
  {
    id: "deposit",
    labelKey: "DashboardPrivateChannels.tabs.deposit",
    href: "/dashboard/payments/private-channels/deposit",
    requiresActive: true,
  },
  {
    id: "transfer",
    labelKey: "DashboardPrivateChannels.tabs.transfer",
    href: "/dashboard/payments/private-channels/transfer",
    requiresActive: true,
  },
  {
    id: "withdraw",
    labelKey: "DashboardPrivateChannels.tabs.withdraw",
    href: "/dashboard/payments/private-channels/withdraw",
    requiresActive: true,
  },
] as const;

interface Props {
  isConnected: boolean;
}

export function PrivateChannelsHeaderTabs({ isConnected }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const t = useTranslations();

  // When no instance is connected only Overview is visible; still render the strip so the
  // sub-views (e.g. Instance) keep a consistent header and a way back to the Overview.
  const visible = TABS.filter((tab) => isConnected || !tab.requiresActive);
  if (visible.length === 0) return null;

  const activeId = visible.find((tab) => pathname.startsWith(tab.href))?.id ?? visible[0].id;

  return (
    <Tabs
      bordered
      value={activeId}
      onValueChange={(value) => {
        const next = visible.find((tab) => tab.id === value);
        if (next) router.push(next.href);
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
