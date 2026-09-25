"use client";

import type { CustodyWalletSummary } from "@sdp/types";
import { LayoutGridIcon, RotateCwIcon, Rows3Icon, SearchIcon, StarIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  formatCustodyProviderName,
  getCustodyProviderEntry,
  isKnownCustodyProvider,
  type KnownCustodyProvider,
} from "@/app/dashboard/custody/provider-catalog";
import { WalletMetadataCopyButton } from "@/app/dashboard/custody/wallet-address-copy-button";
import {
  useWalletCardBalances,
  WalletCardBalanceValue,
} from "@/app/dashboard/custody/wallet-card-balance-value";
import {
  formatWalletMeta,
  formatWalletPurposeLabel,
  truncateMiddle,
} from "@/app/dashboard/custody/wallet-format-utils";
import { DashboardHeaderTabsTrailing } from "@/components/dashboard-header-tabs";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useWalletFavorites } from "@/components/use-wallet-favorites";
import { useLocale, useTranslations } from "@/i18n/provider";
import { useDashboardTab, useDashboardUrlState } from "@/lib/dashboard-url-state";
import { useDebounce } from "@/lib/use-debounce";
import { cn } from "@/lib/utils";
import {
  addWalletFavorite,
  readWalletFavorites,
  removeWalletFavorite,
  restoreWalletFavorites,
  syncWalletFavorites,
  type WalletFavorite,
} from "@/lib/wallet-favorites";
import { WalletActionsMenu } from "./wallet-actions-menu";
import { WalletProviderMark } from "./wallet-provider-mark";
import {
  filterWallets,
  normalizeWalletSearchQuery,
  WALLET_SEARCH_MAX_LENGTH,
  WALLET_SEARCH_QUERY_PARAM,
} from "./wallet-search";

interface WalletsOverviewProps {
  canManageCustody: boolean;
  configsError: string | null;
  wallets: CustodyWalletSummary[];
  walletsError: string | null;
}

type WalletsView = "grid" | "list";

const VIEW_QUERY_PARAM = "view";
/** "Sep 19, 2026, 7:57 PM": when the wallets and balances last arrived. */
const REFRESHED_AT_FORMAT: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" };
/**
 * The design's page has no search field: a handful of wallets reads at a glance. Past this many
 * the grid runs off the screen, so the field appears above it.
 */
const WALLET_SEARCH_THRESHOLD = 6;

interface WalletItem {
  wallet: CustodyWalletSummary;
  provider: KnownCustodyProvider | null;
  name: string;
  /** "Transfers · Fireblocks": the purpose, when it has one, then the provider. */
  kind: string;
  href: string;
}

function toWalletItem(
  wallet: CustodyWalletSummary,
  t: ReturnType<typeof useTranslations>
): WalletItem {
  const provider =
    wallet.provider && isKnownCustodyProvider(wallet.provider) ? wallet.provider : null;
  const providerName = provider
    ? formatCustodyProviderName(provider)
    : wallet.provider
      ? wallet.provider
      : null;
  return {
    wallet,
    provider,
    name: wallet.label?.trim() || truncateMiddle(wallet.publicKey, 6, 6),
    kind: [formatWalletPurposeLabel(wallet.purpose, t), providerName].filter(Boolean).join(" · "),
    href: `/dashboard/wallets/${encodeURIComponent(wallet.walletId)}`,
  };
}

function toFavorite(item: WalletItem): WalletFavorite {
  return {
    walletId: item.wallet.walletId,
    name: item.name,
    provider: item.wallet.provider ?? null,
  };
}

/** The same test the wallet page uses: a known provider says; an unknown one is the local signer. */
function walletSupportsSignerCheck(item: WalletItem): boolean {
  return item.provider
    ? getCustodyProviderEntry(item.provider).supportsSigning
    : !item.wallet.provider;
}

/**
 * Pins or unpins a wallet and says so in a toast with Undo. Undo puts the earlier list back
 * exactly, so an unpinned wallet returns to its old place in the sidebar.
 */
function useFavoriteToggle() {
  const t = useTranslations();
  const { storageKey, favorites } = useWalletFavorites();
  const favoriteIds = useMemo(
    () => new Set(favorites.map((favorite) => favorite.walletId)),
    [favorites]
  );

  const toggle = (item: WalletItem) => {
    if (!storageKey) return;
    const previous = readWalletFavorites(storageKey);
    const undo = {
      label: t("DashboardCustody.undo"),
      onClick: () => restoreWalletFavorites(storageKey, previous),
    };
    if (previous.some((favorite) => favorite.walletId === item.wallet.walletId)) {
      removeWalletFavorite(storageKey, item.wallet.walletId);
      toast(t("DashboardCustody.favoriteRemoved"), {
        description: t("DashboardCustody.favoriteRemovedDescription", { wallet: item.name }),
        action: undo,
      });
      return;
    }
    addWalletFavorite(storageKey, toFavorite(item));
    toast(t("DashboardCustody.favoriteAdded"), {
      description: t("DashboardCustody.favoriteAddedDescription", { wallet: item.name }),
      action: undo,
    });
  };

  return { storageKey, canPin: storageKey !== null, favoriteIds, toggle };
}

function FavoriteButton({
  item,
  pinned,
  onToggle,
}: {
  item: WalletItem;
  pinned: boolean;
  onToggle: (item: WalletItem) => void;
}) {
  const t = useTranslations();
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-pressed={pinned}
      aria-label={t(
        pinned ? "DashboardCustody.removeFromFavorites" : "DashboardCustody.addToFavorites",
        { wallet: item.name }
      )}
      onClick={() => onToggle(item)}
      data-wallet-favorite={item.wallet.walletId}
    >
      <StarIcon className={cn("size-4.5", pinned && "fill-current")} />
    </Button>
  );
}

function WalletRowActions({
  item,
  pinned,
  canPin,
  onToggleFavorite,
}: {
  item: WalletItem;
  pinned: boolean;
  canPin: boolean;
  onToggleFavorite: (item: WalletItem) => void;
}) {
  return (
    <div className="relative z-10 flex items-center">
      {canPin ? <FavoriteButton item={item} pinned={pinned} onToggle={onToggleFavorite} /> : null}
      <WalletActionsMenu
        walletAddress={item.wallet.publicKey}
        walletId={item.wallet.walletId}
        walletLabel={item.wallet.label}
        supportsSignerCheck={walletSupportsSignerCheck(item)}
        triggerMode="kebab"
        openHref={item.href}
      />
    </div>
  );
}

function WalletMark({ item }: { item: WalletItem }) {
  if (item.provider) {
    return <WalletProviderMark provider={item.provider} size="row" />;
  }
  return (
    <span
      aria-hidden="true"
      className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border-subtle text-body font-medium text-tertiary"
    >
      {item.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** A copyable identifier in the card's footer: a caption over the shortened value. */
function WalletIdentifier({
  label,
  copyLabel = label,
  value,
  displayValue,
}: {
  label: string;
  /** What the copy button names, when the caption alone is too terse ("wallet address"). */
  copyLabel?: string;
  value: string;
  displayValue: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-meta text-tertiary">{label}</dt>
      <dd className="relative z-10 flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 truncate text-body text-primary">
          <span aria-hidden="true">{displayValue}</span>
          <span className="sr-only">{value}</span>
        </span>
        <WalletMetadataCopyButton value={value} label={copyLabel} tooltip={value} />
      </dd>
    </div>
  );
}

function WalletCard({
  item,
  pinned,
  canPin,
  onToggleFavorite,
}: {
  item: WalletItem;
  pinned: boolean;
  canPin: boolean;
  onToggleFavorite: (item: WalletItem) => void;
}) {
  const t = useTranslations();
  const { wallet } = item;

  return (
    <article
      className="relative flex min-w-0 flex-col rounded-card bg-surface-tile"
      data-wallet-card={wallet.walletId}
    >
      {/* The whole card opens the wallet; its buttons and copy targets sit above this link. */}
      <Link
        href={item.href}
        className="absolute inset-0 rounded-card focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        <span className="sr-only">
          {t("DashboardCustody.openWalletNamed", { wallet: item.name })}
        </span>
      </Link>
      <div className="flex items-center gap-3 px-4 pt-4">
        <WalletMark item={item} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-nav leading-tight font-medium text-primary">{item.name}</p>
          <p className="truncate text-body text-secondary">
            {item.kind}
            {wallet.isRuntimeExecutionAllowed ? null : (
              <span className="text-warning"> · {t("DashboardCustody.restricted")}</span>
            )}
          </p>
        </div>
        <div className="-mr-2 self-start">
          <WalletRowActions
            item={item}
            pinned={pinned}
            canPin={canPin}
            onToggleFavorite={onToggleFavorite}
          />
        </div>
      </div>
      <p className="px-4 pt-5 pb-6 text-quote">
        <WalletCardBalanceValue
          walletId={wallet.walletId}
          initialBalances={wallet.balances ?? []}
        />
      </p>
      <dl className="grid grid-cols-2 gap-x-6 border-t border-border-subtle px-4 pt-3 pb-3">
        <WalletIdentifier
          label={t("DashboardCustody.address")}
          copyLabel={t("DashboardCustody.walletAddress")}
          value={wallet.publicKey}
          displayValue={formatWalletMeta(wallet.publicKey, 6, 6)}
        />
        <WalletIdentifier
          label={t("DashboardCustody.walletId")}
          value={wallet.walletId}
          displayValue={formatWalletMeta(wallet.walletId, 10, 6)}
        />
      </dl>
    </article>
  );
}

function WalletsList({
  items,
  favoriteIds,
  canPin,
  onToggleFavorite,
}: {
  items: WalletItem[];
  favoriteIds: ReadonlySet<string>;
  canPin: boolean;
  onToggleFavorite: (item: WalletItem) => void;
}) {
  const t = useTranslations();
  return (
    <Table
      className="min-w-0 rounded-none border-0 refresh:-mx-3 [&_table]:table-fixed"
      data-wallet-list
    >
      <TableHeader>
        <TableRow>
          <TableHead className="w-[32%]">{t("DashboardCustody.wallet")}</TableHead>
          <TableHead className="w-[25%]">{t("DashboardCustody.purpose")}</TableHead>
          <TableHead className="w-[14%] text-right">{t("DashboardCustody.balance")}</TableHead>
          <TableHead className="w-[19%] pl-6">{t("DashboardCustody.address")}</TableHead>
          <TableHead className="w-[10%]">
            <span className="sr-only">{t("DashboardCustody.actions")}</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => (
          <TableRow key={item.wallet.walletId} data-wallet-row={item.wallet.walletId}>
            <TableCell>
              <Link
                href={item.href}
                className="flex min-w-0 items-center gap-3 text-primary underline-offset-4 hover:underline"
              >
                {item.provider ? <WalletProviderMark provider={item.provider} size="nav" /> : null}
                <span className="truncate">{item.name}</span>
              </Link>
            </TableCell>
            <TableCell className="truncate text-secondary">{item.kind}</TableCell>
            <TableCell className="text-right">
              <WalletCardBalanceValue
                walletId={item.wallet.walletId}
                initialBalances={item.wallet.balances ?? []}
              />
            </TableCell>
            <TableCell className="pl-6">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-primary">
                  <span aria-hidden="true">{formatWalletMeta(item.wallet.publicKey, 4, 4)}</span>
                  <span className="sr-only">{item.wallet.publicKey}</span>
                </span>
                <WalletMetadataCopyButton
                  value={item.wallet.publicKey}
                  label={t("DashboardCustody.walletAddress")}
                  tooltip={item.wallet.publicKey}
                />
              </span>
            </TableCell>
            <TableCell>
              <div className="flex justify-end">
                <WalletRowActions
                  item={item}
                  pinned={favoriteIds.has(item.wallet.walletId)}
                  canPin={canPin}
                  onToggleFavorite={onToggleFavorite}
                />
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * The tab row's controls: re-read the wallets and their balances, when they last arrived, and
 * the grid or list toggle. The time is set when a read finishes, so it only renders in the
 * browser and never differs between the server and the first client render.
 */
function WalletsToolbar({
  view,
  onViewChange,
}: {
  view: WalletsView;
  onViewChange: (view: WalletsView) => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { data, error, isValidating, mutate } = useWalletCardBalances();
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const wasValidatingRef = useRef(false);

  // Stamped when a read finishes, or on arrival when the cards' read already finished before
  // this row mounted.
  useEffect(() => {
    const finished = wasValidatingRef.current && !isValidating && !error;
    const alreadyLoaded = !isValidating && data !== undefined;
    setRefreshedAt((current) =>
      finished || (current === null && alreadyLoaded) ? new Date() : current
    );
    wasValidatingRef.current = isValidating;
  }, [data, error, isValidating]);

  const refresh = () => {
    router.refresh();
    void mutate();
  };

  return (
    <>
      <span className="flex items-center gap-2 text-body text-tertiary">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={refresh}
          aria-label={t("DashboardCustody.refreshWallets")}
          className="-mr-1"
        >
          <RotateCwIcon
            className={cn("size-4", isValidating && "animate-spin motion-reduce:animate-none")}
          />
        </Button>
        {refreshedAt ? (
          <time dateTime={refreshedAt.toISOString()} data-wallets-refreshed-at>
            {new Intl.DateTimeFormat(locale, REFRESHED_AT_FORMAT).format(refreshedAt)}
          </time>
        ) : null}
      </span>
      <SegmentedControl
        ariaLabel={t("DashboardCustody.walletView")}
        value={view}
        onChange={(value) => onViewChange(value === "list" ? "list" : "grid")}
        options={[
          {
            value: "grid",
            label: t("DashboardCustody.walletViewGrid"),
            icon: <LayoutGridIcon />,
          },
          {
            value: "list",
            label: t("DashboardCustody.walletViewList"),
            icon: <Rows3Icon />,
          },
        ]}
        className="hidden h-control-sm md:flex"
        optionClassName="px-2.5"
      />
    </>
  );
}

function EmptyWallets({
  canManageCustody,
  configsError,
}: {
  canManageCustody: boolean;
  configsError: string | null;
}) {
  const t = useTranslations();
  return (
    <div className="max-w-md" data-wallets-empty>
      <h2 className="text-subheading font-medium text-primary">
        {canManageCustody
          ? t("DashboardCustody.createFirstWallet")
          : t("DashboardCustody.noWalletsAvailable")}
      </h2>
      <p className="mt-2 text-body text-secondary">
        {canManageCustody
          ? t("DashboardCustody.createWalletDescription")
          : t("DashboardCustody.walletCreationLimited")}
      </p>
      {configsError ? <p className="mt-3 text-body text-error">{configsError}</p> : null}
    </div>
  );
}

export function WalletsOverview({
  canManageCustody,
  configsError,
  wallets,
  walletsError,
}: WalletsOverviewProps) {
  const t = useTranslations();
  const isOverviewTab = useDashboardTab() !== "playground";
  const { replaceSearchParams, searchParams } = useDashboardUrlState();
  const view: WalletsView = searchParams.get(VIEW_QUERY_PARAM) === "list" ? "list" : "grid";
  const searchable = wallets.length > WALLET_SEARCH_THRESHOLD;
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
  // A search left in the URL cannot hide wallets on a page that shows no field to clear it.
  const normalizedSearch = searchable ? normalizeWalletSearchQuery(effectiveSearchValue) : "";
  const items = useMemo(() => wallets.map((wallet) => toWalletItem(wallet, t)), [t, wallets]);
  const visibleItems = useMemo(() => {
    if (!normalizedSearch) return items;
    const visible = new Set(filterWallets(wallets, normalizedSearch));
    return items.filter((item) => visible.has(item.wallet));
  }, [items, normalizedSearch, wallets]);
  const searchIsPending = deferredSearchValue !== searchValue;
  const { storageKey, canPin, favoriteIds, toggle } = useFavoriteToggle();

  // A pin keeps the name the list shows now, and a wallet that has gone drops out of the sidebar.
  useEffect(() => {
    if (!storageKey || walletsError) return;
    syncWalletFavorites(storageKey, items.map(toFavorite));
  }, [items, storageKey, walletsError]);

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
      <div role="alert" className="space-y-1 text-body">
        <p className="font-medium text-error">{t("DashboardCustody.unableToLoadWallets")}</p>
        <p className="text-secondary">{walletsError}</p>
      </div>
    );
  }

  if (wallets.length === 0) {
    return <EmptyWallets canManageCustody={canManageCustody} configsError={configsError} />;
  }

  const cards = (
    <div className="grid gap-5 sm:grid-cols-2" data-wallet-grid>
      {visibleItems.map((item) => (
        <WalletCard
          key={item.wallet.walletId}
          item={item}
          pinned={favoriteIds.has(item.wallet.walletId)}
          canPin={canPin}
          onToggleFavorite={toggle}
        />
      ))}
    </div>
  );

  return (
    <div className="space-y-6">
      {isOverviewTab ? (
        <DashboardHeaderTabsTrailing>
          <WalletsToolbar
            view={view}
            onViewChange={(next) =>
              replaceSearchParams({ [VIEW_QUERY_PARAM]: next === "list" ? "list" : null })
            }
          />
        </DashboardHeaderTabsTrailing>
      ) : null}

      {configsError ? <p className="text-body text-secondary">{configsError}</p> : null}

      {searchable ? (
        <div className="max-w-md" data-wallet-search-toolbar>
          <SearchInput
            value={searchValue}
            maxLength={WALLET_SEARCH_MAX_LENGTH}
            onChange={(event) => updateSearchValue(event.target.value)}
            placeholder={t("DashboardCustody.walletSearchPlaceholder")}
            clear={{ label: t("DashboardCustody.clearWalletSearch"), onClear: clearSearch }}
          />
          {normalizedSearch ? (
            <p className="mt-2 text-meta text-secondary" aria-live="polite">
              {t("DashboardCustody.walletSearchResults", {
                count: visibleItems.length,
                total: wallets.length,
              })}
            </p>
          ) : null}
        </div>
      ) : null}

      <div aria-busy={searchIsPending} data-wallet-search-results>
        {normalizedSearch && visibleItems.length === 0 ? (
          <div className="flex flex-col items-start gap-2 py-6">
            <SearchIcon aria-hidden="true" className="size-5 text-tertiary" />
            <h2 className="text-body font-medium text-primary">
              {t("DashboardCustody.noWalletSearchResults")}
            </h2>
            <p className="text-body text-secondary">
              {t("DashboardCustody.noWalletSearchResultsDescription")}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={clearSearch}
            >
              {t("DashboardCustody.clearWalletSearchAction")}
            </Button>
          </div>
        ) : view === "list" ? (
          <>
            {/* The list needs the width; a phone keeps the cards. */}
            <div className="md:hidden">{cards}</div>
            <div className="hidden md:block">
              <WalletsList
                items={visibleItems}
                favoriteIds={favoriteIds}
                canPin={canPin}
                onToggleFavorite={toggle}
              />
            </div>
          </>
        ) : (
          cards
        )}
      </div>
    </div>
  );
}
