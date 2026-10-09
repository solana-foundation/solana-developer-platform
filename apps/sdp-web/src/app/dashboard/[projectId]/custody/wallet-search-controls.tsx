"use client";

import { SearchIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";
import { useTranslations } from "@/i18n/provider";
import { WALLET_SEARCH_MAX_LENGTH } from "./wallet-search";

/**
 * Wallet search toolbar: the search field with its result count, and a trailing actions slot.
 *
 * @param props.searchValue - The typed search value.
 * @param props.normalizedSearch - The normalized query; empty hides the result count.
 * @param props.resultCount - Number of wallets matching the query.
 * @param props.totalCount - Number of wallets before filtering.
 * @param props.onSearchChange - Receives the new typed value.
 * @param props.onClearSearch - Clears the query.
 * @param props.children - Toolbar actions rendered beside the search field.
 * @returns The search toolbar.
 */
export function WalletSearchToolbar({
  searchValue,
  normalizedSearch,
  resultCount,
  totalCount,
  onSearchChange,
  onClearSearch,
  children,
}: {
  searchValue: string;
  normalizedSearch: string;
  resultCount: number;
  totalCount: number;
  onSearchChange: (value: string) => void;
  onClearSearch: () => void;
  children: ReactNode;
}) {
  const t = useTranslations();
  return (
    <div
      className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"
      data-wallet-search-toolbar
    >
      <div className="w-full sm:max-w-md">
        <SearchInput
          value={searchValue}
          maxLength={WALLET_SEARCH_MAX_LENGTH}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={t("DashboardCustody.walletSearchPlaceholder")}
          clear={{ label: t("DashboardCustody.clearWalletSearch"), onClear: onClearSearch }}
        />
        {normalizedSearch ? (
          <p className="mt-2 text-xs text-secondary" aria-live="polite">
            {t("DashboardCustody.walletSearchResults", {
              count: resultCount,
              total: totalCount,
            })}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">{children}</div>
    </div>
  );
}

/**
 * Empty state for a wallet search that matched nothing, with a clear-search action.
 *
 * @param props.onClearSearch - Clears the query.
 * @returns The no-results state.
 */
export function WalletSearchEmptyState({ onClearSearch }: { onClearSearch: () => void }) {
  const t = useTranslations();
  return (
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
      <Button type="button" variant="secondary" className="mt-4" onClick={onClearSearch}>
        {t("DashboardCustody.clearWalletSearchAction")}
      </Button>
    </div>
  );
}
