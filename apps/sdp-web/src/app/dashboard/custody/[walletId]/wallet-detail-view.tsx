"use client";

import { Suspense, useMemo } from "react";
import { WalletFavoriteStar } from "@/app/dashboard/custody/wallet-favorite-button";
import { WalletProviderMark } from "@/app/dashboard/custody/wallet-provider-mark";
import { DashboardPageTitle } from "@/components/dashboard-page-title";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { useDashboardTab, useDashboardUrlState } from "@/lib/dashboard-url-state";
import { WalletActivityTab } from "./wallet-activity-tab";
import type {
  IssuedTokensByMint,
  WalletBalancesResult,
  WalletPageView,
  WalletPolicyResult,
  WalletRevisionsResult,
  WalletTab,
} from "./wallet-detail.shared";
import { WalletOverviewTab } from "./wallet-overview-tab";
import { WalletPolicyTab } from "./wallet-policy-tab";
import { WalletSettingsTab } from "./wallet-settings-tab";

function TabSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden="true">
      <div className="h-16 animate-pulse rounded-card bg-fill-subtle" />
      <div className="h-40 animate-pulse rounded-card bg-fill-subtle" />
    </div>
  );
}

/**
 * One wallet's page, as the design lays it out: its name beside the provider's mark with the
 * star that pins it, then Overview, Activity, Policy (where policies are on) and Settings in
 * the header's tabs (`?tab=`).
 */
export function WalletDetailView({
  wallet,
  balancesPromise,
  policyPromise,
  revisionsPromise,
  issuedTokensPromise,
  issuanceEnabled,
}: {
  wallet: WalletPageView;
  balancesPromise: Promise<WalletBalancesResult>;
  policyPromise: Promise<WalletPolicyResult> | null;
  revisionsPromise: Promise<WalletRevisionsResult> | null;
  issuedTokensPromise: Promise<IssuedTokensByMint>;
  issuanceEnabled: boolean;
}) {
  const requested = useDashboardTab();
  const { replaceSearchParams } = useDashboardUrlState();
  const tab: WalletTab =
    requested === "activity" || requested === "settings"
      ? requested
      : requested === "policy" && policyPromise
        ? "policy"
        : "overview";

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
      <Suspense fallback={<TabSkeleton />}>
        {tab === "overview" ? (
          <WalletOverviewTab
            wallet={wallet}
            balancesPromise={balancesPromise}
            policyPromise={policyPromise}
            issuedTokensPromise={issuedTokensPromise}
            issuanceEnabled={issuanceEnabled}
            onViewAllActivity={() => replaceSearchParams({ tab: "activity" })}
          />
        ) : null}
        {tab === "activity" ? (
          <WalletActivityTab
            walletId={wallet.walletId}
            balancesPromise={balancesPromise}
            issuedTokensPromise={issuedTokensPromise}
          />
        ) : null}
        {tab === "policy" && policyPromise && revisionsPromise ? (
          <WalletPolicyTab
            wallet={wallet}
            policyPromise={policyPromise}
            revisionsPromise={revisionsPromise}
            balancesPromise={balancesPromise}
            issuedTokensPromise={issuedTokensPromise}
          />
        ) : null}
        {tab === "settings" ? <WalletSettingsTab wallet={wallet} /> : null}
      </Suspense>
    </DashboardWorkspaceOverviewPanel>
  );
}
