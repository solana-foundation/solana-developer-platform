"use client";

import type { CustodyWalletSummary } from "@sdp/types";
import Link from "next/link";
import { type ReactNode, useMemo } from "react";
import {
  formatCustodyProviderName,
  isKnownCustodyProvider,
  type KnownCustodyProvider,
} from "@/app/dashboard/[projectId]/custody/provider-catalog";
import {
  WalletAddressCopyButton,
  WalletMetadataCopyButton,
  WalletMetaValue,
} from "@/app/dashboard/[projectId]/custody/wallet-address-copy-button";
import { WalletCardBalanceValue } from "@/app/dashboard/[projectId]/custody/wallet-card-balance-value";
import {
  formatPurpose,
  formatWalletMeta,
} from "@/app/dashboard/[projectId]/custody/wallet-format-utils";
import { WalletLabelInlineEditor } from "@/app/dashboard/[projectId]/custody/wallet-label-inline-editor";
import { Badge } from "@/components/ui/badge";
import { useTranslations } from "@/i18n/provider";
import { useProjectHref } from "@/lib/use-dashboard-project";
import { useWalletSearch } from "./use-wallet-search";
import { WalletProviderMark } from "./wallet-provider-mark";
import { WalletSearchEmptyState, WalletSearchToolbar } from "./wallet-search-controls";
import {
  CreateOptionsUnavailable,
  CreateWalletButton,
  CreateWalletTile,
  type CustodyAvailabilityResult,
  useWalletCreateArea,
} from "./wallets-create-area";
import { EmptyWallets } from "./wallets-empty-state";

type OpenCreateWallet = (provider: KnownCustodyProvider | null) => void;

interface WalletsOverviewProps {
  canManageCustody: boolean;
  connectedProviders: KnownCustodyProvider[];
  custodyAvailability: CustodyAvailabilityResult;
  configsError: string | null;
  wallets: CustodyWalletSummary[];
  walletsError: string | null;
  onCreateWallet: OpenCreateWallet;
}

interface WalletWithProvider {
  wallet: CustodyWalletSummary;
  provider: KnownCustodyProvider | null;
}

function getWalletProvider(wallet: CustodyWalletSummary): KnownCustodyProvider | null {
  return wallet.provider && isKnownCustodyProvider(wallet.provider) ? wallet.provider : null;
}

function WalletCard({
  canManageCustody,
  item,
}: {
  canManageCustody: boolean;
  item: WalletWithProvider;
}) {
  const t = useTranslations();
  const href = useProjectHref();
  const { wallet, provider } = item;
  const purposeLabel = formatPurpose(wallet.purpose, t);

  return (
    <article
      className="relative flex flex-col rounded-2xl border border-border-default bg-surface-raised p-5 shadow-[0_2px_10px_rgba(28,28,29,0.05)] transition hover:border-primary/30 hover:shadow-[0_4px_16px_rgba(28,28,29,0.08)]"
      data-wallet-card={wallet.walletId}
    >
      <Link
        href={href(`/dashboard/wallets/${encodeURIComponent(wallet.walletId)}`)}
        className="absolute inset-0 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-default"
      >
        <span className="sr-only">{t("DashboardCustody.manage")}</span>
      </Link>
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          {provider ? (
            <WalletProviderMark provider={provider} />
          ) : (
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full border border-border-default bg-surface-raised text-lg font-semibold text-tertiary">
              {(wallet.label?.trim() || "W").slice(0, 1).toUpperCase()}
            </div>
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium tracking-wide text-tertiary uppercase">
                {provider ? formatCustodyProviderName(provider) : t("DashboardCustody.wallet")}
              </p>
              {purposeLabel ? (
                <span className="rounded-full border border-border-default bg-fill-subtle px-2 py-0.5 text-[11px] font-medium text-secondary">
                  {purposeLabel}
                </span>
              ) : null}
              {wallet.isRuntimeExecutionAllowed ? null : (
                <Badge variant="warning">{t("DashboardCustody.restricted")}</Badge>
              )}
            </div>
            <div className="relative mt-0.5 min-w-0 text-2xl leading-tight font-medium tracking-tight text-primary">
              <WalletLabelInlineEditor
                walletId={wallet.walletId}
                label={wallet.label}
                canEdit={canManageCustody}
              />
            </div>
          </div>
        </div>
        <div className="shrink-0 text-xl tracking-tight">
          <WalletCardBalanceValue
            walletId={wallet.walletId}
            initialBalances={wallet.balances ?? []}
          />
        </div>
      </div>

      <div className="mt-5 space-y-1.5">
        <div className="flex h-6 items-center justify-between gap-3 text-xs">
          <span className="text-tertiary">{t("DashboardCustody.address")}</span>
          <div className="relative flex min-w-0 items-center gap-1">
            <WalletMetaValue
              value={wallet.publicKey}
              displayValue={formatWalletMeta(wallet.publicKey)}
            />
            <WalletAddressCopyButton address={wallet.publicKey} tooltip={wallet.publicKey} />
          </div>
        </div>
        <div className="flex h-6 items-center justify-between gap-3 text-xs">
          <span className="text-tertiary">{t("DashboardCustody.walletId")}</span>
          <div className="relative flex min-w-0 items-center gap-1">
            <WalletMetaValue
              value={wallet.walletId}
              displayValue={formatWalletMeta(wallet.walletId, 10, 6)}
            />
            <WalletMetadataCopyButton
              value={wallet.walletId}
              label={t("DashboardCustody.walletId")}
              tooltip={wallet.walletId}
            />
          </div>
        </div>
      </div>
    </article>
  );
}

function WalletCardsGrid({
  canManageCustody,
  children,
  wallets,
}: {
  canManageCustody: boolean;
  children?: ReactNode;
  wallets: WalletWithProvider[];
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {wallets.map((item) => (
        <WalletCard key={item.wallet.walletId} item={item} canManageCustody={canManageCustody} />
      ))}
      {children}
    </div>
  );
}

export function WalletsOverview({
  canManageCustody,
  connectedProviders,
  custodyAvailability,
  configsError,
  wallets,
  walletsError,
  onCreateWallet,
}: WalletsOverviewProps) {
  const t = useTranslations();
  const { providerAvailability, createOptionsUnavailable, canCreateWallet } = useWalletCreateArea({
    canManageCustody,
    connectedProviders,
    custodyAvailability,
  });
  const {
    searchValue,
    normalizedSearch,
    visibleWallets,
    searchIsPending,
    updateSearchValue,
    clearSearch,
  } = useWalletSearch(wallets);
  const walletsWithProvider = useMemo(
    () =>
      visibleWallets.map((wallet) => ({
        wallet,
        provider: getWalletProvider(wallet),
      })),
    [visibleWallets]
  );

  if (walletsError) {
    return (
      <div className="rounded-[20px] border border-destructive/15 bg-destructive/[0.04] px-5 py-4 text-sm text-destructive-strongest">
        <p className="font-semibold">{t("DashboardCustody.unableToLoadWallets")}</p>
        <p className="mt-1">{walletsError}</p>
      </div>
    );
  }

  if (wallets.length === 0) {
    return (
      <EmptyWallets
        canManageCustody={canManageCustody}
        configsError={configsError}
        onCreateWallet={onCreateWallet}
        providerAvailability={providerAvailability}
      />
    );
  }

  return (
    <div className="space-y-6">
      {createOptionsUnavailable ? <CreateOptionsUnavailable /> : null}
      {configsError ? (
        <div className="rounded-[18px] border border-border-default bg-fill-subtle px-4 py-3 text-sm text-secondary">
          {configsError}
        </div>
      ) : null}

      <WalletSearchToolbar
        searchValue={searchValue}
        normalizedSearch={normalizedSearch}
        resultCount={visibleWallets.length}
        totalCount={wallets.length}
        onSearchChange={updateSearchValue}
        onClearSearch={clearSearch}
      >
        {canCreateWallet ? <CreateWalletButton onClick={() => onCreateWallet(null)} /> : null}
      </WalletSearchToolbar>

      <div aria-busy={searchIsPending} data-wallet-search-results>
        {normalizedSearch && visibleWallets.length === 0 ? (
          <WalletSearchEmptyState onClearSearch={clearSearch} />
        ) : (
          <WalletCardsGrid wallets={walletsWithProvider} canManageCustody={canManageCustody}>
            {!normalizedSearch && canCreateWallet ? (
              <CreateWalletTile onClick={() => onCreateWallet(null)} />
            ) : null}
          </WalletCardsGrid>
        )}
      </div>
    </div>
  );
}
