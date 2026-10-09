"use client";

import type { KnownCustodyProvider } from "@/app/dashboard/[projectId]/custody/provider-catalog";
import { useTranslations } from "@/i18n/provider";
import type { CustodyProviderAvailability } from "./provider-display-status";
import { WalletProviderChoices } from "./wallet-provider-choices";
import { CreateOptionsUnavailable } from "./wallets-create-area";

/**
 * First-run state for a project with no wallets: a heading for the viewer's permission and the
 * provider choices, or the unavailable notice when availability could not be read.
 *
 * @param props.canManageCustody - Whether the viewer may create wallets.
 * @param props.configsError - Custody config load error to surface, if any.
 * @param props.onCreateWallet - Opens the create-wallet flow for the chosen provider.
 * @param props.providerAvailability - Resolved provider availability, or `null` when unreadable.
 * @returns The empty wallets state.
 */
export function EmptyWallets({
  canManageCustody,
  configsError,
  onCreateWallet,
  providerAvailability,
}: {
  canManageCustody: boolean;
  configsError: string | null;
  onCreateWallet: (provider: KnownCustodyProvider | null) => void;
  providerAvailability: CustodyProviderAvailability[] | null;
}) {
  const t = useTranslations();
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 py-8">
      <div className="max-w-2xl space-y-2">
        <h2 className="text-[32px] leading-[1.08] font-medium tracking-[-0.04em] text-primary">
          {canManageCustody
            ? t("DashboardCustody.createFirstWallet")
            : t("DashboardCustody.noWalletsAvailable")}
        </h2>
        <p className="text-sm leading-6 text-secondary">
          {canManageCustody
            ? t("DashboardCustody.createWalletDescription")
            : t("DashboardCustody.walletCreationLimited")}
        </p>
        {configsError ? <p className="text-sm text-destructive-strong">{configsError}</p> : null}
      </div>

      {providerAvailability === null ? (
        <CreateOptionsUnavailable />
      ) : (
        <WalletProviderChoices
          availability={providerAvailability}
          canSelect={canManageCustody}
          grouped={false}
          selectedProvider={null}
          onSelect={onCreateWallet}
        />
      )}
    </div>
  );
}
