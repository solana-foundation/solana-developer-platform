"use client";

import type { CustodyWalletSummary } from "@sdp/types";
import { Plus } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  CUSTODY_PROVIDER_CATALOG,
  type CustodyProviderCatalogEntry,
  formatCustodyProviderName,
  isKnownCustodyProvider,
  type KnownCustodyProvider,
} from "@/app/dashboard/custody/provider-catalog";
import {
  WalletAddressCopyButton,
  WalletMetadataCopyButton,
} from "@/app/dashboard/custody/wallet-address-copy-button";
import { WalletCardBalanceValue } from "@/app/dashboard/custody/wallet-card-balance-value";
import { formatPurpose, formatWalletMeta } from "@/app/dashboard/custody/wallet-format-utils";
import { WalletLabelInlineEditor } from "@/app/dashboard/custody/wallet-label-inline-editor";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { WalletProviderMark } from "./wallet-provider-mark";

type OpenCreateWallet = (provider: KnownCustodyProvider | null) => void;

interface WalletsOverviewProps {
  canManageCustody: boolean;
  enabledProviders: KnownCustodyProvider[];
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

function getEnabledProviderEntries(
  enabledProviders: KnownCustodyProvider[]
): CustodyProviderCatalogEntry[] {
  const enabledProviderSet = new Set(enabledProviders);
  return CUSTODY_PROVIDER_CATALOG.filter((provider) => enabledProviderSet.has(provider.id));
}

function CreateWalletTile({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-[340px] cursor-pointer items-center justify-center rounded-2xl border border-dashed border-[rgba(28,28,29,0.2)] bg-[#fcfcfa] text-[rgba(28,28,29,0.5)] transition-colors hover:border-[rgba(28,28,29,0.35)] hover:text-[rgba(28,28,29,0.75)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(28,28,29,0.18)] focus-visible:ring-offset-2"
      aria-label="Create wallet"
    >
      <Plus className="h-6 w-6" />
    </button>
  );
}

function ProviderChoiceCard({
  isDisabled,
  onCreateWallet,
  provider,
}: {
  isDisabled: boolean;
  onCreateWallet: OpenCreateWallet;
  provider: CustodyProviderCatalogEntry;
}) {
  return (
    <article className="flex min-h-[300px] flex-col rounded-2xl border border-[rgba(28,28,29,0.1)] bg-[#fcfcfa] p-5 shadow-[0_2px_10px_rgba(28,28,29,0.05)]">
      <div className="flex items-start justify-between gap-3">
        <WalletProviderMark provider={provider.id} />
      </div>

      <div className="mt-5 space-y-2">
        <h3 className="text-[30px] leading-[1.1] font-medium tracking-[-0.03em] text-[#1c1c1d]">
          {provider.label}
        </h3>
        <p className="text-sm leading-6 text-[rgba(28,28,29,0.62)]">{provider.description}</p>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {provider.capabilities.map((feature) => (
          <span
            key={feature}
            className="rounded-full border border-[rgba(28,28,29,0.1)] bg-[rgba(28,28,29,0.03)] px-2.5 py-1 text-[11px] font-medium text-[rgba(28,28,29,0.68)]"
          >
            {feature}
          </span>
        ))}
      </div>

      <div className="mt-auto pt-6">
        <Button
          type="button"
          variant="secondary"
          className="w-full"
          onClick={() => onCreateWallet(provider.id)}
          disabled={isDisabled}
          title={
            isDisabled
              ? `${provider.label} is already connected, but additional wallets are not available yet.`
              : undefined
          }
        >
          New wallet
        </Button>
      </div>
    </article>
  );
}

function WalletCard({
  canManageCustody,
  item,
}: {
  canManageCustody: boolean;
  item: WalletWithProvider;
}) {
  const { wallet, provider } = item;
  const purposeLabel = formatPurpose(wallet.purpose);

  return (
    <article className="flex min-h-[340px] flex-col rounded-2xl border border-[rgba(28,28,29,0.1)] bg-[#fcfcfa] p-5 shadow-[0_2px_10px_rgba(28,28,29,0.05)]">
      <div className="mb-4">
        {provider ? (
          <WalletProviderMark provider={provider} />
        ) : (
          <div className="flex h-14 w-14 items-center justify-center rounded-full border border-[rgba(28,28,29,0.1)] bg-white text-lg font-semibold text-[rgba(28,28,29,0.58)]">
            {(wallet.label?.trim() || "W").slice(0, 1).toUpperCase()}
          </div>
        )}
      </div>

      <p className="text-sm font-medium tracking-wide text-[rgba(28,28,29,0.58)] uppercase">
        {provider ? formatCustodyProviderName(provider) : "Wallet"}
      </p>
      <div className="mt-1 min-w-0 text-[30px] leading-[1.1] font-medium tracking-[-0.03em] text-[#1c1c1d]">
        <div className="min-w-0">
          <WalletLabelInlineEditor
            walletId={wallet.walletId}
            label={wallet.label}
            canEdit={canManageCustody}
          />
        </div>
      </div>

      <div className="mt-6 space-y-2 rounded-xl border border-[rgba(28,28,29,0.08)] bg-[rgba(28,28,29,0.03)] p-3">
        <div className="flex items-center justify-between text-sm">
          <span className="text-[rgba(28,28,29,0.58)]">Balance</span>
          <WalletCardBalanceValue
            walletId={wallet.walletId}
            initialBalances={wallet.balances ?? []}
          />
        </div>
        {purposeLabel ? (
          <div className="flex items-center justify-between text-sm">
            <span className="text-[rgba(28,28,29,0.58)]">Purpose</span>
            <span className="font-medium text-[#1c1c1d]">{purposeLabel}</span>
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="text-[rgba(28,28,29,0.58)]">Address</span>
          <div className="flex min-w-0 items-center gap-2">
            <WalletMetaValue
              value={wallet.publicKey}
              displayValue={formatWalletMeta(wallet.publicKey)}
            />
            <WalletAddressCopyButton address={wallet.publicKey} />
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="text-[rgba(28,28,29,0.58)]">Wallet ID</span>
          <div className="flex min-w-0 items-center gap-2">
            <WalletMetaValue
              value={wallet.walletId}
              displayValue={formatWalletMeta(wallet.walletId, 10, 6)}
            />
            <WalletMetadataCopyButton value={wallet.walletId} label="Wallet ID" />
          </div>
        </div>
      </div>

      <div className="mt-auto pt-3">
        <Button asChild variant="outline" className="h-11 w-full rounded-[10px]">
          <Link href={`/dashboard/wallets/${encodeURIComponent(wallet.walletId)}`}>Manage</Link>
        </Button>
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
  enabledProviders,
  configsError,
  wallets,
  walletsError,
  onCreateWallet,
}: WalletsOverviewProps) {
  const enabledProviderEntries = getEnabledProviderEntries(enabledProviders);
  const walletsWithProvider = wallets.map((wallet) => ({
    wallet,
    provider: getWalletProvider(wallet),
  }));

  if (walletsError) {
    return (
      <div className="rounded-[20px] border border-[#c71f37]/15 bg-[#c71f37]/[0.04] px-5 py-4 text-sm text-[#8a1f2a]">
        <p className="font-semibold">Unable to load wallets</p>
        <p className="mt-1">{walletsError}</p>
      </div>
    );
  }

  if (wallets.length === 0) {
    return (
      <div className="mx-auto flex max-w-6xl flex-col gap-6 py-8">
        <div className="max-w-2xl space-y-2">
          <h2 className="text-[32px] leading-[1.08] font-medium tracking-[-0.04em] text-[#1c1c1d]">
            {canManageCustody ? "Create your first wallet" : "No wallets available"}
          </h2>
          <p className="text-sm leading-6 text-[rgba(28,28,29,0.62)]">
            {canManageCustody
              ? "Choose the provider that will create and sign for the wallet."
              : "Wallet creation is limited to admins. Once a wallet is created, you can still use it across the dashboard."}
          </p>
          {configsError ? <p className="text-sm text-[#9e2b38]">{configsError}</p> : null}
          {canManageCustody && enabledProviderEntries.length === 0 ? (
            <p className="text-sm text-[rgba(28,28,29,0.62)]">
              No wallet providers are enabled for this organization tier right now.
            </p>
          ) : null}
        </div>

        {canManageCustody && enabledProviderEntries.length > 0 ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {enabledProviderEntries.map((provider) => (
              <ProviderChoiceCard
                key={provider.id}
                provider={provider}
                isDisabled={false}
                onCreateWallet={onCreateWallet}
              />
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {configsError ? (
        <div className="rounded-[18px] border border-[rgba(28,28,29,0.1)] bg-[rgba(28,28,29,0.03)] px-4 py-3 text-sm text-[rgba(28,28,29,0.68)]">
          {configsError}
        </div>
      ) : null}

      {canManageCustody && enabledProviderEntries.length > 0 ? (
        <div className="flex justify-end">
          <Button type="button" className="w-full sm:w-auto" onClick={() => onCreateWallet(null)}>
            Create Wallet
          </Button>
        </div>
      ) : null}

      <TooltipProvider>
        <WalletCardsGrid wallets={walletsWithProvider} canManageCustody={canManageCustody}>
          {canManageCustody && enabledProviderEntries.length > 0 ? (
            <CreateWalletTile onClick={() => onCreateWallet(null)} />
          ) : null}
        </WalletCardsGrid>
      </TooltipProvider>
    </div>
  );
}

function WalletMetaValue({ value, displayValue }: { value: string; displayValue: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="block max-w-[18ch] truncate font-mono text-xs text-[rgba(28,28,29,0.72)]">
          <span aria-hidden="true">{displayValue}</span>
          <span className="sr-only">{value}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" align="end" className="max-w-[32rem] break-all text-xs">
        {value}
      </TooltipContent>
    </Tooltip>
  );
}
