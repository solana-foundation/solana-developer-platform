"use client";

import Link from "next/link";
import { use, useMemo, useState } from "react";
import { ArrowPagination } from "@/components/ui/arrow-pagination";
import { Button } from "@/components/ui/button";
import { FilterMenu, FilterMenuOptions } from "@/components/ui/filter-menu";
import { ListToolbar, RowsPerPageSelect } from "@/components/ui/list-toolbar";
import { SearchInput } from "@/components/ui/search-input";
import { useTranslations } from "@/i18n/provider";
import { toTitleCase } from "../../activity-format-utils";
import type { WalletActivityRow } from "../wallet-activity.data";
import { useWalletActivityWindow } from "./use-wallet-activity-window";
import { WalletActivityTable } from "./wallet-activity-table";
import {
  activityDisplayId,
  type IssuedTokensByMint,
  symbolsByMint,
  type WalletBalancesResult,
  walletTransactionsHref,
} from "./wallet-detail.shared";
import { EmptyNote } from "./wallet-overview-tab";

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function matchesActivity(
  row: WalletActivityRow,
  { needle, type, status }: { needle: string; type?: string; status?: string }
): boolean {
  if (type !== undefined && row.operationLabel !== type) return false;
  if (status !== undefined && row.status !== status) return false;
  if (!needle) return true;
  return [
    row.operationLabel,
    activityDisplayId(row.id),
    row.id,
    row.status,
    row.amount,
    row.address,
  ]
    .join(" ")
    .toLowerCase()
    .includes(needle);
}

/**
 * Search, type and status filters over the loaded rows, a page at a time.
 *
 * TODO(api): search and filter the wallet's whole history once the API serves one activity feed
 * per wallet. Activity merges two separately paged lists, payment transfers and issuance
 * transactions, and issuance transactions have no search, so these cover the loaded rows only.
 * Known limitation of the API, not of this tab.
 */
function useActivityFilters(rows: readonly WalletActivityRow[]) {
  const [query, setQuery] = useState("");
  const [type, setType] = useState<string | undefined>();
  const [status, setStatus] = useState<string | undefined>();
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);
  const types = useMemo(() => distinct(rows.map((row) => row.operationLabel)), [rows]);
  const statuses = useMemo(() => distinct(rows.map((row) => row.status)), [rows]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => matchesActivity(row, { needle, type, status }));
  }, [rows, query, type, status]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const resetPage =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      setPage(1);
    };
  return {
    query,
    type,
    status,
    pageSize,
    types,
    statuses,
    filtered,
    pageCount,
    currentPage,
    visible: filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    setPage,
    setQuery: resetPage(setQuery),
    setType: resetPage(setType),
    setStatus: resetPage(setStatus),
    setPageSize: resetPage(setPageSize),
    clear: () => {
      setQuery("");
      setType(undefined);
      setStatus(undefined);
      setPage(1);
    },
  };
}

/**
 * "Load older activity" under the last page. After a wider read fails it says so and the same
 * button retries that size; the rows above stay the window that last loaded.
 */
function LoadOlderActivity({
  loadedCount,
  loading,
  failed,
  onLoad,
}: {
  loadedCount: number;
  loading: boolean;
  failed: boolean;
  onLoad: () => void;
}) {
  const t = useTranslations();
  return (
    <div className="flex flex-col items-center gap-2">
      {failed ? (
        <p className="text-meta text-tertiary" role="status" data-wallet-activity-older-failed>
          {t("DashboardCustody.walletActivityLoadOlderFailed", { count: loadedCount })}
        </p>
      ) : null}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={loading}
        onClick={onLoad}
        data-wallet-activity-load-older
      >
        {t(
          failed
            ? "DashboardCustody.walletActivityRetryLoadOlder"
            : "DashboardCustody.walletActivityLoadOlder"
        )}
      </Button>
    </div>
  );
}

/**
 * The wallet's activity, newest first, searchable and filterable by type and status, a page at
 * a time. The feed starts with the latest rows; at the end of what it holds, "Load older
 * activity" widens it to older ones, up to the feed's largest window. Search and filters cover
 * the loaded rows, so while older ones remain the tab says so and links to the Transactions
 * ledger narrowed to this wallet, which searches and pages its whole history on the server.
 */
export function WalletActivityTab({
  walletId,
  custodyWalletId,
  balancesPromise,
  issuedTokensPromise,
}: {
  walletId: string;
  custodyWalletId: string;
  balancesPromise: Promise<WalletBalancesResult>;
  issuedTokensPromise: Promise<IssuedTokensByMint>;
}) {
  const t = useTranslations();
  const { balances } = use(balancesPromise);
  const issued = use(issuedTokensPromise);
  const symbols = useMemo(() => symbolsByMint(balances, issued), [balances, issued]);
  const activity = useWalletActivityWindow(walletId);
  const { data } = activity;
  const feedRows = data?.activityRows;
  const rows = useMemo(() => feedRows ?? [], [feedRows]);
  const filters = useActivityFilters(rows);

  if (!data) {
    return activity.error ? (
      <p className="text-body text-tertiary">{t("DashboardCustody.walletActivityUnavailable")}</p>
    ) : (
      <div className="h-40 animate-pulse rounded-control bg-fill-subtle" aria-hidden="true" />
    );
  }
  if (data.activityError) {
    return <p className="text-body text-tertiary">{data.activityError}</p>;
  }
  if (rows.length === 0) {
    return (
      <EmptyNote title={t("DashboardCustody.walletNoActivityTitle")}>
        {t("DashboardCustody.walletNoActivityTabBody")}
      </EmptyNote>
    );
  }

  const anyLabel = t("Shared.SharedComponents.any");
  const { type, status, filtered, pageSize, currentPage, pageCount } = filters;
  return (
    <div className="flex min-w-0 flex-col gap-5" data-wallet-activity-tab>
      <ListToolbar
        filters={
          <FilterMenu
            label={t("Shared.SharedComponents.filter")}
            searchPlaceholder={t("Shared.SharedComponents.filterBy")}
            sections={[
              {
                id: "type",
                label: t("DashboardCustody.walletFilterType"),
                value: type,
                content: (
                  <FilterMenuOptions
                    value={type}
                    anyLabel={anyLabel}
                    options={filters.types.map((value) => ({ value, label: value }))}
                    onChange={(value) => filters.setType(value ?? undefined)}
                  />
                ),
              },
              {
                id: "status",
                label: t("DashboardCustody.status"),
                value: status === undefined ? undefined : toTitleCase(status),
                content: (
                  <FilterMenuOptions
                    value={status}
                    anyLabel={anyLabel}
                    options={filters.statuses.map((value) => ({
                      value,
                      label: toTitleCase(value),
                    }))}
                    onChange={(value) => filters.setStatus(value ?? undefined)}
                  />
                ),
              },
            ]}
          />
        }
      >
        <RowsPerPageSelect value={pageSize} onChange={filters.setPageSize} />
        <SearchInput
          value={filters.query}
          onChange={(event) => filters.setQuery(event.target.value)}
          clear={{
            label: t("DashboardCustody.walletClearActivitySearch"),
            onClear: () => filters.setQuery(""),
          }}
          placeholder={t("DashboardCustody.walletSearchActivity")}
          className="min-w-0 flex-1 sm:w-56 sm:flex-none"
        />
      </ListToolbar>
      {data.activityNotice ? (
        <p className="text-meta text-tertiary">{data.activityNotice}</p>
      ) : null}
      {activity.refreshFailed ? (
        <p className="text-meta text-tertiary">{t("DashboardCustody.walletActivityUnavailable")}</p>
      ) : null}
      {data.hasMore ? (
        <p className="text-meta text-tertiary" data-wallet-activity-capped>
          {t("DashboardCustody.walletActivityLatestOnly", { count: rows.length })}{" "}
          <Link
            href={walletTransactionsHref(custodyWalletId)}
            className="text-primary hover:underline"
          >
            {t("DashboardCustody.walletActivityOpenTransactions")}
          </Link>
        </p>
      ) : null}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-start gap-4">
          <EmptyNote title={t("DashboardCustody.walletNothingMatches")}>
            {t("DashboardCustody.walletNothingMatchesBody")}
          </EmptyNote>
          <Button type="button" variant="outline" size="sm" onClick={filters.clear}>
            {t("DashboardCustody.walletClearFilters")}
          </Button>
        </div>
      ) : (
        <WalletActivityTable rows={filters.visible} symbols={symbols} />
      )}
      {filtered.length > pageSize ? (
        <ArrowPagination page={currentPage} pageCount={pageCount} onPageChange={filters.setPage} />
      ) : null}
      {activity.canLoadOlder && currentPage === pageCount ? (
        <LoadOlderActivity
          loadedCount={rows.length}
          loading={activity.loadingOlder}
          failed={activity.olderFailed}
          onLoad={activity.loadOlder}
        />
      ) : null}
    </div>
  );
}
