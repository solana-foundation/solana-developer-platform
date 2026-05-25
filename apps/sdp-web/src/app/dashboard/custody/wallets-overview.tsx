"use client";

import type { CustodyWalletSummary } from "@sdp/types";
import { FileCode2, Plus, Shield, WalletMinimal } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import {
  CUSTODY_PROVIDER_CATALOG,
  type CustodyProviderCatalogEntry,
  formatCustodyProviderName,
  getCustodyProviderCategory,
  isKnownCustodyProvider,
  type KnownCustodyProvider,
  WALLET_PROVIDER_CATEGORIES,
  WALLET_PROVIDER_CATEGORY_DETAILS,
  type WalletProviderCategory,
} from "@/app/dashboard/custody/provider-catalog";
import { WalletAddressCopyButton } from "@/app/dashboard/custody/wallet-address-copy-button";
import { WalletCardBalanceValue } from "@/app/dashboard/custody/wallet-card-balance-value";
import { formatPurpose, formatWalletMeta } from "@/app/dashboard/custody/wallet-format-utils";
import { WalletLabelInlineEditor } from "@/app/dashboard/custody/wallet-label-inline-editor";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { WalletProviderMark } from "./wallet-provider-mark";

type WalletFilter = "all" | WalletProviderCategory;
type OpenCreateWallet = (
  provider: KnownCustodyProvider | null,
  category?: WalletProviderCategory | null
) => void;

interface WalletsOverviewProps {
  canManageCustody: boolean;
  enabledProviders: KnownCustodyProvider[];
  configsError: string | null;
  wallets: CustodyWalletSummary[];
  walletsError: string | null;
  onCreateWallet: OpenCreateWallet;
}

interface WalletWithCategory {
  wallet: CustodyWalletSummary;
  provider: KnownCustodyProvider | null;
  category: WalletProviderCategory | null;
}

const filterOptions: Array<{ id: WalletFilter; label: string }> = [
  { id: "all", label: "All" },
  ...WALLET_PROVIDER_CATEGORIES.map((category) => ({
    id: category,
    label: WALLET_PROVIDER_CATEGORY_DETAILS[category].label,
  })),
];

const filterTooltips: Partial<Record<WalletProviderCategory, string>> = {
  server:
    "API-driven wallet infrastructure for products and automated operations. Create wallets, sign transactions, and run payment flows programmatically.",
  institutional:
    "Governed custody for treasury and settlement. Use provider controls, policies, and multi-party approvals for sensitive operations.",
};

function CategoryIcon({ category }: { category: WalletProviderCategory }) {
  const Icon = category === "server" ? WalletMinimal : Shield;
  return <Icon className="h-3.5 w-3.5 text-[#1c1c1d]" aria-hidden="true" />;
}

function getWalletProvider(wallet: CustodyWalletSummary): KnownCustodyProvider | null {
  return wallet.provider && isKnownCustodyProvider(wallet.provider) ? wallet.provider : null;
}

function getWalletCategory(provider: KnownCustodyProvider | null): WalletProviderCategory | null {
  return provider ? getCustodyProviderCategory(provider) : null;
}

function getEnabledProviderEntries(
  enabledProviders: KnownCustodyProvider[]
): CustodyProviderCatalogEntry[] {
  const enabledProviderSet = new Set(enabledProviders);
  return CUSTODY_PROVIDER_CATALOG.filter((provider) => enabledProviderSet.has(provider.id));
}

function WalletFilterControl({
  filter,
  onChange,
}: {
  filter: WalletFilter;
  onChange: (filter: WalletFilter) => void;
}) {
  return (
    <TooltipProvider>
      <div className="inline-flex max-w-full items-center overflow-x-auto rounded-xl border border-[rgba(28,28,29,0.1)] bg-[rgba(28,28,29,0.03)] p-1">
        {filterOptions.map((option) => {
          const isActive = filter === option.id;
          const tooltip = option.id === "all" ? null : filterTooltips[option.id];
          const button = (
            <button
              key={option.id}
              type="button"
              onClick={() => onChange(option.id)}
              className={cn(
                "inline-flex h-9 shrink-0 items-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors",
                isActive
                  ? "bg-white text-[#1c1c1d] shadow-[0_1px_2px_rgba(28,28,29,0.08)]"
                  : "text-[rgba(28,28,29,0.62)] hover:text-[#1c1c1d]"
              )}
              aria-pressed={isActive}
            >
              {option.id !== "all" ? <CategoryIcon category={option.id} /> : null}
              <span>{option.label}</span>
            </button>
          );

          if (!tooltip) {
            return button;
          }

          return (
            <Tooltip key={option.id}>
              <TooltipTrigger asChild>{button}</TooltipTrigger>
              <TooltipContent
                side="top"
                align="center"
                sideOffset={8}
                className="w-[18.75rem] max-w-full whitespace-normal break-words text-left text-xs leading-5 text-white"
              >
                <span className="block font-medium text-white">{option.label} wallets</span>
                <span className="mt-1 block whitespace-normal text-white/75">{tooltip}</span>
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}

function EndpointChip({ endpoint }: { endpoint: string }) {
  const [method, ...pathParts] = endpoint.split(" ");

  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-[rgba(28,28,29,0.1)] bg-white px-2 py-1 font-mono text-[11px] text-[rgba(28,28,29,0.68)]">
      <span className="font-semibold text-[#1c1c1d]">{method}</span>
      <span className="truncate">{pathParts.join(" ")}</span>
    </span>
  );
}

function WalletOnboardingCapabilityPanel() {
  return (
    <section className="rounded-lg border border-[rgba(28,28,29,0.1)] bg-[#fcfbf8] p-5">
      <div className="flex items-center gap-2">
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-[#f4f1ea] text-[#1c1c1d] ring-1 ring-[rgba(28,28,29,0.08)]">
          <FileCode2 className="h-4 w-4" aria-hidden="true" />
        </span>
        <p className="text-sm font-medium text-[#1c1c1d]">API capability</p>
      </div>
      <p className="mt-3 text-sm leading-6 text-[rgba(28,28,29,0.62)]">
        Create provider-backed wallets, run signer checks, and use those wallets for payment
        transfer flows.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <EndpointChip endpoint="POST /v1/wallets/initialize" />
        <EndpointChip endpoint="POST /v1/wallets" />
        <EndpointChip endpoint="POST /v1/wallets/signer-check" />
      </div>
    </section>
  );
}

function OnboardingCategoryCard({
  category,
  providers,
  onCreateWallet,
}: {
  category: WalletProviderCategory;
  providers: CustodyProviderCatalogEntry[];
  onCreateWallet: OpenCreateWallet;
}) {
  const details = WALLET_PROVIDER_CATEGORY_DETAILS[category];
  const isDisabled = providers.length === 0;

  return (
    <button
      type="button"
      onClick={() => onCreateWallet(null, category)}
      disabled={isDisabled}
      className={cn(
        "w-full rounded-lg border border-[rgba(28,28,29,0.1)] bg-white px-4 py-4 text-left transition-colors hover:bg-[#f8f6f1]",
        isDisabled ? "cursor-not-allowed opacity-50 hover:bg-white" : ""
      )}
      aria-label={`Set up ${details.label} wallet`}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[#f4f1ea] ring-1 ring-[rgba(28,28,29,0.08)]">
          <CategoryIcon category={category} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-lg leading-6 font-medium text-[#1c1c1d]">
            {details.label} wallet
          </span>
          <span className="mt-1 block text-sm leading-6 text-[rgba(28,28,29,0.62)]">
            {details.description}
          </span>
          <span className="mt-3 block">
            {providers.length > 0 ? (
              <span className="text-sm text-[rgba(28,28,29,0.58)]">
                {providers.length} {providers.length === 1 ? "provider" : "providers"} available
              </span>
            ) : (
              <span className="text-sm text-[rgba(28,28,29,0.58)]">
                No enabled providers in this category.
              </span>
            )}
          </span>
        </span>
      </div>
    </button>
  );
}

function CreateWalletTile({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-[340px] items-center justify-center rounded-2xl border border-dashed border-[rgba(28,28,29,0.2)] bg-[#fcfcfa] text-[rgba(28,28,29,0.5)] transition-colors hover:border-[rgba(28,28,29,0.35)] hover:text-[rgba(28,28,29,0.75)]"
      aria-label="Create wallet"
    >
      <Plus className="h-6 w-6" />
    </button>
  );
}

function WalletCard({
  canManageCustody,
  item,
}: {
  canManageCustody: boolean;
  item: WalletWithCategory;
}) {
  const { wallet, provider } = item;
  const purposeLabel = formatPurpose(wallet.purpose);

  return (
    <article className="flex min-h-[340px] flex-col rounded-2xl border border-[rgba(28,28,29,0.1)] bg-[#fcfcfa] p-5 shadow-[0_2px_10px_rgba(28,28,29,0.05)]">
      <div className="mb-4 flex items-start justify-between gap-3">
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
            <span
              className="max-w-[18ch] truncate font-mono text-xs text-[rgba(28,28,29,0.72)]"
              title={wallet.publicKey}
            >
              {formatWalletMeta(wallet.publicKey)}
            </span>
            <WalletAddressCopyButton address={wallet.publicKey} />
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="text-[rgba(28,28,29,0.58)]">Wallet ID</span>
          <span
            className="max-w-[18ch] truncate font-mono text-xs text-[rgba(28,28,29,0.72)]"
            title={wallet.walletId}
          >
            {formatWalletMeta(wallet.walletId, 10, 6)}
          </span>
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
  wallets: WalletWithCategory[];
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

function CategoryEmptyState({
  canManageCustody,
  category,
  providers,
}: {
  canManageCustody: boolean;
  category: WalletProviderCategory;
  providers: CustodyProviderCatalogEntry[];
}) {
  const details = WALLET_PROVIDER_CATEGORY_DETAILS[category];
  const categoryLabel = details.label.toLowerCase();

  return (
    <div className="rounded-2xl border border-[rgba(28,28,29,0.1)] bg-[#fcfcfa] px-5 py-6 text-sm text-[rgba(28,28,29,0.68)]">
      <p className="font-medium text-[#1c1c1d]">No {categoryLabel} wallets yet</p>
      <p className="mt-1">
        {canManageCustody && providers.length === 0
          ? `No ${categoryLabel} wallet providers are enabled for this organization tier right now.`
          : `Wallet creation is limited to admins. Once a ${categoryLabel} wallet is created, it will appear here.`}
      </p>
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
  const [filter, setFilter] = useState<WalletFilter>("all");
  const enabledProviderEntries = useMemo(
    () => getEnabledProviderEntries(enabledProviders),
    [enabledProviders]
  );
  const walletsWithCategory = useMemo<WalletWithCategory[]>(
    () =>
      wallets.map((wallet) => {
        const provider = getWalletProvider(wallet);
        return {
          wallet,
          provider,
          category: getWalletCategory(provider),
        };
      }),
    [wallets]
  );
  if (walletsError) {
    return (
      <div className="rounded-[20px] border border-[#c71f37]/15 bg-[#c71f37]/[0.04] px-5 py-4 text-sm text-[#8a1f2a]">
        <p className="font-semibold">Unable to load wallets</p>
        <p className="mt-1">{walletsError}</p>
      </div>
    );
  }

  if (wallets.length === 0) {
    const enabledProviderCount = enabledProviderEntries.length;

    return (
      <div className="mx-auto flex max-w-6xl flex-col gap-6 py-8">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl space-y-2">
            <h2 className="text-[32px] leading-[1.08] font-medium tracking-[-0.04em] text-[#1c1c1d]">
              {canManageCustody ? "Create your first wallet" : "No wallets available"}
            </h2>
            <p className="text-sm leading-6 text-[rgba(28,28,29,0.62)]">
              {canManageCustody
                ? "Start with a custody model, then pick the provider that will create and sign for the wallet."
                : "Wallet creation is limited to admins. Once a wallet is created, you can still use it across the dashboard."}
            </p>
            {configsError ? <p className="text-sm text-[#9e2b38]">{configsError}</p> : null}
            {canManageCustody && enabledProviderCount === 0 ? (
              <p className="text-sm text-[rgba(28,28,29,0.62)]">
                No wallet providers are enabled for this organization tier right now.
              </p>
            ) : null}
          </div>
        </div>

        {canManageCustody && enabledProviderCount > 0 ? (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
            <div className="space-y-3">
              {WALLET_PROVIDER_CATEGORIES.map((category) => {
                const providers = enabledProviderEntries.filter(
                  (provider) => provider.category === category
                );

                return (
                  <OnboardingCategoryCard
                    key={category}
                    category={category}
                    providers={providers}
                    onCreateWallet={onCreateWallet}
                  />
                );
              })}
            </div>
            <WalletOnboardingCapabilityPanel />
          </div>
        ) : null}
      </div>
    );
  }

  const selectedCategory = filter === "all" ? null : filter;
  const selectedCategoryProviders = selectedCategory
    ? enabledProviderEntries.filter((provider) => provider.category === selectedCategory)
    : [];
  const selectedCategoryWallets = selectedCategory
    ? walletsWithCategory.filter((item) => item.category === selectedCategory)
    : [];
  const visibleWallets = selectedCategory ? selectedCategoryWallets : walletsWithCategory;
  const visibleCreateWalletCategory = selectedCategory ?? null;
  const canCreateVisibleWallet =
    canManageCustody &&
    (selectedCategory ? selectedCategoryProviders.length > 0 : enabledProviderEntries.length > 0);
  const createWalletTile = canCreateVisibleWallet ? (
    <CreateWalletTile
      key={`create-wallet-${filter}`}
      onClick={() => onCreateWallet(null, visibleCreateWalletCategory)}
    />
  ) : null;

  return (
    <div className="space-y-6">
      {configsError ? (
        <div className="rounded-[18px] border border-[rgba(28,28,29,0.1)] bg-[rgba(28,28,29,0.03)] px-4 py-3 text-sm text-[rgba(28,28,29,0.68)]">
          {configsError}
        </div>
      ) : null}

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <WalletFilterControl filter={filter} onChange={setFilter} />

        {canManageCustody && enabledProviderEntries.length > 0 ? (
          <Button type="button" className="w-full lg:w-auto" onClick={() => onCreateWallet(null)}>
            Create Wallet
          </Button>
        ) : null}
      </div>
      <div className="space-y-8">
        {visibleWallets.length > 0 || createWalletTile ? (
          <WalletCardsGrid wallets={visibleWallets} canManageCustody={canManageCustody}>
            {createWalletTile}
          </WalletCardsGrid>
        ) : selectedCategory ? (
          <CategoryEmptyState
            canManageCustody={canManageCustody}
            category={selectedCategory}
            providers={selectedCategoryProviders}
          />
        ) : null}
      </div>
    </div>
  );
}
