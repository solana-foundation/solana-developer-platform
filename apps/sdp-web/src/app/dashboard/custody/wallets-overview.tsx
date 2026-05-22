"use client";

import type { CustodyWalletSummary } from "@sdp/types";
import { Plus, Shield, Zap } from "lucide-react";
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
import { WalletCategoryBadge } from "@/app/dashboard/custody/wallet-category-badge";
import { formatPurpose, formatWalletMeta } from "@/app/dashboard/custody/wallet-format-utils";
import { WalletLabelInlineEditor } from "@/app/dashboard/custody/wallet-label-inline-editor";
import { Button } from "@/components/ui/button";
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

function CategoryIcon({ category }: { category: WalletProviderCategory }) {
  const Icon = category === "server" ? Zap : Shield;
  return (
    <Icon
      className={cn("h-3.5 w-3.5", category === "server" ? "text-[#0b6fb8]" : "text-[#a45113]")}
      aria-hidden="true"
    />
  );
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
    <div className="inline-flex max-w-full items-center overflow-x-auto rounded-xl border border-[rgba(28,28,29,0.1)] bg-[rgba(28,28,29,0.03)] p-1">
      {filterOptions.map((option) => {
        const isActive = filter === option.id;

        return (
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
      })}
    </div>
  );
}

function ProviderChip({ provider }: { provider: CustodyProviderCatalogEntry }) {
  return (
    <span className="inline-flex h-8 items-center gap-2 rounded-full border border-[rgba(28,28,29,0.1)] bg-white px-2.5 text-sm font-medium text-[rgba(28,28,29,0.68)]">
      <WalletProviderMark provider={provider.id} size="xs" />
      {provider.label}
    </span>
  );
}

function CategoryIntro({
  category,
  enabledProviders,
}: {
  category: WalletProviderCategory;
  enabledProviders: CustodyProviderCatalogEntry[];
}) {
  const details = WALLET_PROVIDER_CATEGORY_DETAILS[category];

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
      <p className="max-w-[480px] text-[15px] leading-6 text-[rgba(28,28,29,0.62)] lg:basis-[480px]">
        {details.description}
      </p>
      {enabledProviders.length > 0 ? (
        <div className="flex flex-wrap gap-2 lg:min-w-[460px] lg:flex-1 lg:justify-end">
          {enabledProviders.map((provider) => (
            <ProviderChip key={provider.id} provider={provider} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CategoryProviderMarks({ providers }: { providers: CustodyProviderCatalogEntry[] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {providers.map((provider) => (
        <WalletProviderMark key={provider.id} provider={provider.id} size="sm" />
      ))}
    </div>
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
  const Icon = category === "server" ? Zap : Shield;
  const isDisabled = providers.length === 0;

  return (
    <article
      className={cn(
        "flex min-h-[420px] flex-col rounded-[24px] border border-[rgba(28,28,29,0.12)] bg-white p-6 shadow-[0_2px_12px_rgba(28,28,29,0.04)]",
        isDisabled ? "opacity-60" : ""
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div
          className={cn(
            "flex h-12 w-12 items-center justify-center rounded-xl",
            category === "server" ? "bg-[#d9efff] text-[#0b6fb8]" : "bg-[#ffe3b8] text-[#a45113]"
          )}
        >
          <Icon className="h-6 w-6" aria-hidden="true" />
        </div>
      </div>

      <div className="mt-8 space-y-4">
        <h3 className="text-[34px] leading-[1.05] font-medium tracking-[-0.04em] text-[#1c1c1d]">
          {details.label}
        </h3>
        <p className="text-[17px] leading-7 text-[rgba(28,28,29,0.62)]">{details.description}</p>
      </div>

      <div className="mt-auto space-y-6 pt-8">
        {providers.length > 0 ? (
          <CategoryProviderMarks providers={providers} />
        ) : (
          <p className="text-sm text-[rgba(28,28,29,0.58)]">
            No enabled providers in this category.
          </p>
        )}
        <Button
          type="button"
          className="h-12 w-full rounded-[12px] focus-visible:!ring-0 focus-visible:!ring-offset-0"
          onClick={() => onCreateWallet(null, category)}
          disabled={isDisabled}
        >
          Set up {details.label} wallet
        </Button>
      </div>
    </article>
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
  const { wallet, provider, category } = item;
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
        {category ? <WalletCategoryBadge category={category} compact /> : null}
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

function CategoryFilteredWalletGrid({
  canManageCustody,
  category,
  onCreateWallet,
  providers,
  wallets,
}: {
  canManageCustody: boolean;
  category: WalletProviderCategory;
  onCreateWallet: OpenCreateWallet;
  providers: CustodyProviderCatalogEntry[];
  wallets: WalletWithCategory[];
}) {
  const createTile =
    canManageCustody && providers.length > 0 ? (
      <CreateWalletTile onClick={() => onCreateWallet(null, category)} />
    ) : null;

  if (wallets.length === 0) {
    return createTile ? (
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{createTile}</div>
    ) : (
      <CategoryEmptyState
        canManageCustody={canManageCustody}
        category={category}
        providers={providers}
      />
    );
  }

  return (
    <WalletCardsGrid wallets={wallets} canManageCustody={canManageCustody}>
      {createTile}
    </WalletCardsGrid>
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
      <div className="mx-auto flex min-h-[560px] max-w-6xl flex-col justify-center gap-10 py-12 lg:py-20">
        <div className="mx-auto max-w-3xl space-y-4 text-center">
          <h2 className="text-[48px] leading-[1.02] font-medium tracking-[-0.05em] text-[#1c1c1d]">
            {canManageCustody ? "Create your first wallet" : "No wallets available"}
          </h2>
          <p className="text-[20px] leading-8 text-[rgba(28,28,29,0.62)]">
            {canManageCustody
              ? "Choose how this wallet will be governed. You can mix both types later."
              : "Wallet creation is limited to admins. Once a wallet is created, you can still use it across the dashboard."}
          </p>
          {configsError ? <p className="text-sm text-[#9e2b38]">{configsError}</p> : null}
          {canManageCustody && enabledProviderCount === 0 ? (
            <p className="text-sm text-[rgba(28,28,29,0.62)]">
              No wallet providers are enabled for this organization tier right now.
            </p>
          ) : null}
        </div>

        {canManageCustody && enabledProviderCount > 0 ? (
          <div className="grid gap-6 lg:grid-cols-2">
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
      {selectedCategory ? (
        <CategoryIntro category={selectedCategory} enabledProviders={selectedCategoryProviders} />
      ) : null}

      <div className="space-y-8">
        {filter === "all" ? (
          <WalletCardsGrid wallets={walletsWithCategory} canManageCustody={canManageCustody}>
            {canManageCustody && enabledProviderEntries.length > 0 ? (
              <CreateWalletTile onClick={() => onCreateWallet(null)} />
            ) : null}
          </WalletCardsGrid>
        ) : (
          <CategoryFilteredWalletGrid
            category={filter}
            wallets={selectedCategoryWallets}
            providers={selectedCategoryProviders}
            canManageCustody={canManageCustody}
            onCreateWallet={onCreateWallet}
          />
        )}
      </div>
    </div>
  );
}
