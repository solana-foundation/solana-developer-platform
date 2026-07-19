"use client";

import type { CustodyWalletSummary } from "@sdp/types";
import { Plus, SearchIcon, XIcon } from "lucide-react";
import { type ReactNode, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  CUSTODY_CAPABILITY_LABEL_KEYS,
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
import { DashboardNavigationLink as Link } from "@/components/dashboard-navigation-link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useTranslations } from "@/i18n/provider";
import { useDashboardUrlState } from "@/lib/dashboard-url-state";
import { useDebounce } from "@/lib/use-debounce";
import { WalletProviderMark } from "./wallet-provider-mark";
import {
  filterWallets,
  normalizeWalletSearchQuery,
  WALLET_SEARCH_MAX_LENGTH,
  WALLET_SEARCH_QUERY_PARAM,
} from "./wallet-search";

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
  const t = useTranslations();
  return (
    <button
      type="button"
      onClick={onClick}
      data-wallet-create-tile
      className="flex min-h-[340px] cursor-pointer items-center justify-center rounded-2xl border border-dashed border-border-strong bg-surface-raised text-tertiary transition-colors hover:border-primary/40 hover:text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-default focus-visible:ring-offset-2"
      aria-label={t("DashboardCustody.createWallet")}
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
  const t = useTranslations();
  return (
    <article className="flex min-h-[300px] flex-col rounded-2xl border border-border-default bg-surface-raised p-5 shadow-[0_2px_10px_rgba(28,28,29,0.05)]">
      <div className="flex items-start justify-between gap-3">
        <WalletProviderMark provider={provider.id} />
      </div>

      <div className="mt-5 space-y-2">
        <h3 className="text-[30px] leading-[1.1] font-medium tracking-[-0.03em] text-primary">
          {provider.label}
        </h3>
        <p className="text-sm leading-6 text-secondary">{t(provider.descriptionKey)}</p>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {provider.capabilities.map((feature) => (
          <span
            key={feature}
            className="rounded-full border border-border-default bg-fill-subtle px-2.5 py-1 text-[11px] font-medium text-secondary"
          >
            {t(CUSTODY_CAPABILITY_LABEL_KEYS[feature])}
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
              ? t("DashboardCustody.providerAdditionalWalletUnavailable", {
                  provider: provider.label,
                })
              : undefined
          }
        >
          {t("DashboardCustody.newWallet")}
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
  const t = useTranslations();
  const { wallet, provider } = item;
  const purposeLabel = formatPurpose(wallet.purpose, t);

  return (
    <article
      className="flex min-h-[340px] flex-col rounded-2xl border border-border-default bg-surface-raised p-5 shadow-[0_2px_10px_rgba(28,28,29,0.05)]"
      data-wallet-card={wallet.walletId}
    >
      <div className="mb-4">
        {provider ? (
          <WalletProviderMark provider={provider} />
        ) : (
          <div className="flex h-14 w-14 items-center justify-center rounded-full border border-border-default bg-white text-lg font-semibold text-tertiary">
            {(wallet.label?.trim() || "W").slice(0, 1).toUpperCase()}
          </div>
        )}
      </div>

      <p className="text-sm font-medium tracking-wide text-tertiary uppercase">
        {provider ? formatCustodyProviderName(provider) : t("DashboardCustody.wallet")}
      </p>
      <div className="mt-1 min-w-0 text-[30px] leading-[1.1] font-medium tracking-[-0.03em] text-primary">
        <div className="min-w-0">
          <WalletLabelInlineEditor
            walletId={wallet.walletId}
            label={wallet.label}
            canEdit={canManageCustody}
          />
        </div>
      </div>

      <div className="mt-6 space-y-2 rounded-xl border border-border-subtle bg-fill-subtle p-3">
        <div className="flex items-center justify-between text-sm">
          <span className="text-tertiary">{t("DashboardCustody.balance")}</span>
          <WalletCardBalanceValue
            walletId={wallet.walletId}
            initialBalances={wallet.balances ?? []}
          />
        </div>
        {purposeLabel ? (
          <div className="flex items-center justify-between text-sm">
            <span className="text-tertiary">{t("DashboardCustody.purpose")}</span>
            <span className="font-medium text-primary">{purposeLabel}</span>
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="text-tertiary">{t("DashboardCustody.address")}</span>
          <div className="flex min-w-0 items-center gap-2">
            <WalletMetaValue
              value={wallet.publicKey}
              displayValue={formatWalletMeta(wallet.publicKey)}
            />
            <WalletAddressCopyButton address={wallet.publicKey} />
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="text-tertiary">{t("DashboardCustody.walletId")}</span>
          <div className="flex min-w-0 items-center gap-2">
            <WalletMetaValue
              value={wallet.walletId}
              displayValue={formatWalletMeta(wallet.walletId, 10, 6)}
            />
            <WalletMetadataCopyButton
              value={wallet.walletId}
              label={t("DashboardCustody.walletId")}
            />
          </div>
        </div>
      </div>

      <div className="mt-auto pt-3">
        <Button asChild variant="outline" className="h-11 w-full rounded-[10px]">
          <Link href={`/dashboard/wallets/${encodeURIComponent(wallet.walletId)}`}>
            {t("DashboardCustody.manage")}
          </Link>
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
  const t = useTranslations();
  const { replaceSearchParams, searchParams } = useDashboardUrlState();
  const initialSearch = normalizeWalletSearchQuery(
    searchParams.get(WALLET_SEARCH_QUERY_PARAM) ?? ""
  );
  const [searchValue, setSearchValue] = useState(initialSearch);
  const deferredSearchValue = useDeferredValue(searchValue);
  const effectiveSearchValue = normalizeWalletSearchQuery(searchValue)
    ? deferredSearchValue
    : searchValue;
  const debouncedSearch = useDebounce(normalizeWalletSearchQuery(searchValue), 200);
  const lastUrlSearchRef = useRef(initialSearch);
  const syncingFromUrlRef = useRef<string | null>(null);
  const enabledProviderEntries = useMemo(
    () => getEnabledProviderEntries(enabledProviders),
    [enabledProviders]
  );
  const normalizedSearch = normalizeWalletSearchQuery(effectiveSearchValue);
  const visibleWallets = useMemo(
    () => filterWallets(wallets, normalizedSearch),
    [normalizedSearch, wallets]
  );
  const walletsWithProvider = useMemo(
    () =>
      visibleWallets.map((wallet) => ({
        wallet,
        provider: getWalletProvider(wallet),
      })),
    [visibleWallets]
  );
  const searchIsPending = deferredSearchValue !== searchValue;

  useEffect(() => {
    const urlSearch = normalizeWalletSearchQuery(searchParams.get(WALLET_SEARCH_QUERY_PARAM) ?? "");
    if (urlSearch === lastUrlSearchRef.current) return;

    lastUrlSearchRef.current = urlSearch;
    syncingFromUrlRef.current = urlSearch;
    setSearchValue(urlSearch);
  }, [searchParams]);

  useEffect(() => {
    if (syncingFromUrlRef.current !== null) {
      if (debouncedSearch === syncingFromUrlRef.current) {
        syncingFromUrlRef.current = null;
      }
      return;
    }
    if (debouncedSearch === lastUrlSearchRef.current) return;

    lastUrlSearchRef.current = debouncedSearch;
    replaceSearchParams({
      [WALLET_SEARCH_QUERY_PARAM]: debouncedSearch || null,
    });
  }, [debouncedSearch, replaceSearchParams]);

  const updateSearchValue = (value: string) => {
    syncingFromUrlRef.current = null;
    setSearchValue(value);
  };

  const clearSearch = () => {
    lastUrlSearchRef.current = "";
    syncingFromUrlRef.current = null;
    setSearchValue("");
    replaceSearchParams({ [WALLET_SEARCH_QUERY_PARAM]: null });
  };

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
          {canManageCustody && enabledProviderEntries.length === 0 ? (
            <p className="text-sm text-secondary">{t("DashboardCustody.noWalletProvidersTier")}</p>
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
        <div className="rounded-[18px] border border-border-default bg-fill-subtle px-4 py-3 text-sm text-secondary">
          {configsError}
        </div>
      ) : null}

      <div
        className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"
        data-wallet-search-toolbar
      >
        <div className="w-full sm:max-w-md">
          <Input
            value={searchValue}
            maxLength={WALLET_SEARCH_MAX_LENGTH}
            onChange={(event) => updateSearchValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && searchValue) clearSearch();
            }}
            placeholder={t("DashboardCustody.walletSearchPlaceholder")}
            aria-label={t("DashboardCustody.walletSearchPlaceholder")}
            iconLeft={<SearchIcon />}
            action={
              searchValue ? (
                <button
                  type="button"
                  aria-label={t("DashboardCustody.clearWalletSearch")}
                  onClick={clearSearch}
                  className="rounded text-tertiary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-default"
                >
                  <XIcon className="size-5" />
                </button>
              ) : undefined
            }
          />
          {normalizedSearch ? (
            <p className="mt-2 text-xs text-secondary" aria-live="polite">
              {t("DashboardCustody.walletSearchResults", {
                count: visibleWallets.length,
                total: wallets.length,
              })}
            </p>
          ) : null}
        </div>

        {canManageCustody && enabledProviderEntries.length > 0 ? (
          <Button type="button" className="w-full sm:w-auto" onClick={() => onCreateWallet(null)}>
            {t("DashboardCustody.createWallet")}
          </Button>
        ) : null}
      </div>

      <div aria-busy={searchIsPending} data-wallet-search-results>
        {normalizedSearch && visibleWallets.length === 0 ? (
          <div className="flex min-h-64 flex-col items-center justify-center rounded-2xl border border-dashed border-border-default bg-surface-raised px-6 text-center">
            <span className="flex size-11 items-center justify-center rounded-xl bg-fill-subtle text-secondary">
              <SearchIcon className="size-5" />
            </span>
            <h2 className="mt-4 text-base font-medium text-primary">
              {t("DashboardCustody.noWalletSearchResults")}
            </h2>
            <p className="mt-1 max-w-md text-sm text-secondary">
              {t("DashboardCustody.noWalletSearchResultsDescription")}
            </p>
            <Button type="button" variant="secondary" className="mt-4" onClick={clearSearch}>
              {t("DashboardCustody.clearWalletSearchAction")}
            </Button>
          </div>
        ) : (
          <TooltipProvider>
            <WalletCardsGrid wallets={walletsWithProvider} canManageCustody={canManageCustody}>
              {!normalizedSearch && canManageCustody && enabledProviderEntries.length > 0 ? (
                <CreateWalletTile onClick={() => onCreateWallet(null)} />
              ) : null}
            </WalletCardsGrid>
          </TooltipProvider>
        )}
      </div>
    </div>
  );
}

function WalletMetaValue({ value, displayValue }: { value: string; displayValue: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="block max-w-[18ch] truncate font-mono text-xs text-secondary">
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
