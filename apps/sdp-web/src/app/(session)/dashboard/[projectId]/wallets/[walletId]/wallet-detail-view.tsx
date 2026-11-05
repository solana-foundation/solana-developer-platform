"use client";

import { useMemo } from "react";
import { WalletFavoriteStar } from "@/app/(session)/dashboard/[projectId]/wallets/wallet-favorite-button";
import { WalletProviderMark } from "@/app/(session)/dashboard/[projectId]/wallets/wallet-provider-mark";
import { DashboardPageTitle } from "@/components/dashboard-page-title";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { useDashboardTab, useDashboardUrlState } from "@/lib/dashboard-url-state";
import { WalletActivityTab } from "./wallet-activity-tab";
import type { WalletPageView, WalletTab } from "./wallet-detail.shared";
import { WalletOverviewTab } from "./wallet-overview-tab";
import { WalletSettingsTab } from "./wallet-settings-tab";

/**
 * One wallet's page, as the design lays it out: its name beside the provider's mark with the
 * star that pins it, then Overview, Activity and Settings in the header's tabs (`?tab=`).
 */
export function WalletDetailView({
  wallet,
  issuanceEnabled,
}: {
  wallet: WalletPageView;
  issuanceEnabled: boolean;
}) {
  const requested = useDashboardTab();
  const { replaceSearchParams } = useDashboardUrlState();
  const tab: WalletTab =
    requested === "activity" || requested === "settings" ? requested : "overview";

  // Stable elements, so the shell's header is set once per wallet rather than every render.
  const mark = useMemo(
    () => <WalletProviderMark provider={wallet.provider} size="page" />,
    [wallet.provider]
  );
  const actions = useMemo(
    () => (
      <WalletFavoriteStar
        favorite={{
          walletId: wallet.walletId,
          name: wallet.name,
          provider: wallet.provider,
        }}
      />
    ),
    [wallet.walletId, wallet.name, wallet.provider]
  );

  return (
    <DashboardWorkspaceOverviewPanel data-wallet-detail={tab}>
      <DashboardPageTitle title={wallet.name} mark={mark} actions={actions} />
      {tab === "overview" ? (
        <WalletOverviewTab
          wallet={wallet}
          issuanceEnabled={issuanceEnabled}
          onViewAllActivity={() => replaceSearchParams({ tab: "activity" })}
        />
      ) : null}
      {tab === "activity" ? (
        <WalletActivityTab
          key={wallet.walletId}
          walletId={wallet.walletId}
          custodyWalletId={wallet.custodyWalletId}
          issuanceEnabled={issuanceEnabled}
        />
      ) : null}
      {tab === "settings" ? <WalletSettingsTab wallet={wallet} /> : null}
    </DashboardWorkspaceOverviewPanel>
  );
}
