"use client";

import type { CustodyProvider, CustodyWalletSummary } from "@sdp/types/custody";
import { Button } from "@sdp/ui/button";
import { PlusIcon } from "lucide-react";
import { formatCustodyProviderName } from "@/app/(session)/dashboard/[projectId]/wallets/provider-catalog";
import { WalletAddressCopyButton } from "@/app/(session)/dashboard/[projectId]/wallets/wallet-address-copy-button";
import { formatWalletMeta } from "@/app/(session)/dashboard/[projectId]/wallets/wallet-format-utils";
import { WalletProviderMark } from "@/app/(session)/dashboard/[projectId]/wallets/wallet-provider-mark";
import { EntityLink } from "@/components/entity-link";
import { RecordBlock } from "@/components/refresh-record";
import { useTranslations } from "@/i18n/provider";
import { useProjectHref } from "@/lib/use-dashboard-project";

/**
 * The line under a wallet's name: the provider, then what the wallet is for, or why it cannot
 * sign. A wallet on an ended connection cannot sign through it any more, whatever its own
 * status still says.
 */
function walletSubtitle(
  wallet: CustodyWalletSummary,
  provider: CustodyProvider,
  isDeactivated: boolean,
  t: ReturnType<typeof useTranslations>
): string {
  const parts = [formatCustodyProviderName(provider)];
  if (isDeactivated) {
    parts.push(t("DashboardCustody.walletReadOnly"));
  } else if (wallet.status !== "active") {
    parts.push(wallet.status);
  }
  if (wallet.purpose?.trim()) {
    parts.push(wallet.purpose.trim());
  }
  return parts.join(" · ");
}

/**
 * The connection's wallets.
 *
 * Each row links to the wallet's own page, which owns every action on it; duplicating those
 * controls here would give the same operation two homes that could disagree. The one action
 * here is adding a wallet to this connection.
 */
export function ConnectionWalletsCard({
  wallets,
  walletsUnavailable,
  isDeactivated,
  pendingWalletLabel,
  provider,
  onAddWallet,
}: {
  wallets: CustodyWalletSummary[];
  walletsUnavailable: boolean;
  isDeactivated: boolean;
  pendingWalletLabel: string | null;
  provider: CustodyProvider;
  /** `null` when the viewer cannot add a wallet here. */
  onAddWallet: (() => void) | null;
}) {
  const t = useTranslations();
  const href = useProjectHref();

  return (
    <RecordBlock
      title={t("DashboardCustody.wallets")}
      hint={t("DashboardCustody.connectionWalletsHint")}
    >
      {wallets.length > 0 ? (
        <ul>
          {wallets.map((wallet) => (
            <li
              key={wallet.walletId}
              data-wallet-id={wallet.walletId}
              className="flex min-w-0 items-center gap-3 border-b border-border-subtle py-3 last:border-b-0"
            >
              <WalletProviderMark provider={provider} size="row" />
              <div className="min-w-0 flex-1">
                <EntityLink
                  href={href(`/dashboard/wallets/${encodeURIComponent(wallet.walletId)}`)}
                  className="text-field text-primary"
                >
                  {wallet.label?.trim() || wallet.walletId}
                </EntityLink>
                <p className="truncate text-body text-secondary">
                  {walletSubtitle(wallet, provider, isDeactivated, t)}
                </p>
              </div>
              <span className="flex shrink-0 items-center gap-1">
                <span className="text-body text-secondary tabular-nums">
                  {formatWalletMeta(wallet.publicKey, 4, 4)}
                </span>
                <WalletAddressCopyButton address={wallet.publicKey} tooltip={wallet.publicKey} />
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-body text-tertiary">
          {walletsUnavailable
            ? t("DashboardCustody.connectionWalletsUnavailable")
            : pendingWalletLabel
              ? t("DashboardCustody.walletsPendingSetup")
              : t("DashboardCustody.connectionNoWallets")}
        </p>
      )}
      {onAddWallet ? (
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={onAddWallet}
            iconLeft={<PlusIcon className="size-4" />}
          >
            {t("DashboardCustody.addWalletAction")}
          </Button>
        </div>
      ) : null}
    </RecordBlock>
  );
}
