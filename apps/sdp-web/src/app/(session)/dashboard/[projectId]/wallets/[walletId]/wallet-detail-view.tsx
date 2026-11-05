"use client";

import type { CustodyWalletMetadata } from "@sdp/types/custody";
import { Button } from "@sdp/ui/button";
import { useMemo } from "react";
import ProjectNotFound from "@/app/(session)/dashboard/[projectId]/not-found";
import { useWalletRecord } from "@/app/(session)/dashboard/[projectId]/wallets/custody-reads";
import {
  formatCustodyProviderName,
  getCustodyProviderEntry,
  isKnownCustodyProvider,
} from "@/app/(session)/dashboard/[projectId]/wallets/provider-catalog";
import { WalletFavoriteStar } from "@/app/(session)/dashboard/[projectId]/wallets/wallet-favorite-button";
import { formatWalletPurposeLabel } from "@/app/(session)/dashboard/[projectId]/wallets/wallet-format-utils";
import { WalletProviderMark } from "@/app/(session)/dashboard/[projectId]/wallets/wallet-provider-mark";
import { WalletDetailSkeleton } from "@/app/(session)/dashboard/[projectId]/wallets/wallet-route-skeletons";
import { DashboardPageTitle } from "@/components/dashboard-page-title";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import { useDashboardTab, useDashboardUrlState } from "@/lib/dashboard-url-state";
import { WalletActivityTab } from "./wallet-activity-tab";
import type { WalletPageView, WalletTab } from "./wallet-detail.shared";
import { WalletOverviewTab } from "./wallet-overview-tab";
import { WalletSettingsTab } from "./wallet-settings-tab";

type Translate = ReturnType<typeof useTranslations>;

/** What the page shows about the wallet itself, from its record and its connection's. */
function toWalletPageView(
  wallet: CustodyWalletMetadata,
  connection: WalletPageView["connection"],
  canManageCustody: boolean,
  t: Translate
): WalletPageView {
  const provider =
    wallet.provider && isKnownCustodyProvider(wallet.provider) ? wallet.provider : null;
  const label = wallet.label?.trim() || null;
  return {
    walletId: wallet.walletId,
    custodyWalletId: wallet.id,
    name: label ?? t("DashboardCustody.untitledWallet"),
    label,
    publicKey: wallet.publicKey,
    provider,
    providerName: provider
      ? formatCustodyProviderName(provider)
      : (wallet.provider ?? t("DashboardCustody.unknown")),
    purposeLabel: formatWalletPurposeLabel(wallet.purpose, t),
    createdAt: wallet.createdAt ?? null,
    isRuntimeExecutionAllowed: wallet.isRuntimeExecutionAllowed,
    supportsSignerCheck: provider
      ? getCustodyProviderEntry(provider).supportsSigning
      : !wallet.provider,
    connection,
    canManageCustody,
  };
}

/** One wallet's page: its skeleton while the record loads, the Project's not-found if it is gone. */
export function WalletDetailView({
  walletId,
  issuanceEnabled,
}: {
  walletId: string;
  issuanceEnabled: boolean;
}) {
  const t = useTranslations();
  const { dashboardAccess } = useDashboardWorkspace();
  const { data, error, isValidating, mutate } = useWalletRecord(walletId);
  // A wallet deleted elsewhere 404s on the revisit's refetch, over its cached record.
  if (error?.status === 404) return <ProjectNotFound />;
  if (data === undefined) {
    if (error === undefined) return <WalletDetailSkeleton />;
    return (
      <DashboardWorkspaceOverviewPanel>
        <div role="alert" className="flex flex-col items-start gap-2 text-body">
          <p className="font-medium text-error">{t("DashboardCustody.walletUnavailable")}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            loading={isValidating}
            onClick={() => void mutate()}
          >
            {t("DashboardCustody.retryRead")}
          </Button>
        </div>
      </DashboardWorkspaceOverviewPanel>
    );
  }
  const wallet = toWalletPageView(
    data.wallet,
    data.connection,
    dashboardAccess.capabilities.canManageCustody,
    t
  );
  return <WalletDetailContent wallet={wallet} issuanceEnabled={issuanceEnabled} />;
}

/**
 * One wallet's page, as the design lays it out: its name beside the provider's mark with the
 * star that pins it, then Overview, Activity and Settings in the header's tabs (`?tab=`).
 */
function WalletDetailContent({
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
