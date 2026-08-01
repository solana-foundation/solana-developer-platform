"use client";

import { Tab, TabList, Tabs } from "@solana/design-system/tabs";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "@/i18n/provider";

// Adding a new sub-page (transfers, channels, members, …):
//   1. Create app/dashboard/payments/private-channels/<slug>/page.tsx
//   2. Append { id, labelKey, href, requiresActive: true } ABOVE the Instance entry
//      (Instance always stays last so the connect/disconnect surface is at the
//      end of the tab bar even as new features land).
const TABS = [
  {
    id: "overview",
    labelKey: "DashboardPrivateChannels.tabs.overview",
    href: "/dashboard/payments/private-channels/overview",
    requiresActive: true,
  },
  {
    id: "channels",
    labelKey: "DashboardPrivateChannels.tabs.channels",
    href: "/dashboard/payments/private-channels/channels",
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
  {
    id: "members",
    labelKey: "DashboardPrivateChannels.tabs.members",
    href: "/dashboard/payments/private-channels/members",
    requiresActive: true,
  },
  {
    id: "events",
    labelKey: "DashboardPrivateChannels.tabs.events",
    href: "/dashboard/payments/private-channels/events",
    // Always visible: project feed survives instance disconnect/delete.
    requiresActive: false,
  },
  {
    id: "instance",
    labelKey: "DashboardPrivateChannels.tabs.instance",
    href: "/dashboard/payments/private-channels/instance",
    requiresActive: false,
  },
] as const;

interface Props {
  isConnected: boolean;
}

export function PrivateChannelsHeaderTabs({ isConnected }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const t = useTranslations();

  const visible = TABS.filter((tab) => isConnected || !tab.requiresActive);
  if (visible.length < 2) return null;

  const activeId = visible.find((tab) => pathname.startsWith(tab.href))?.id ?? visible[0].id;

  return (
    <div className="mb-6">
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
    </div>
  );
}
