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
import { WALLET_ACTIVITY_LIMIT, WALLET_ACTIVITY_MAX_LIMIT } from "../wallet-activity.data";
import { useWalletActivity } from "./use-wallet-activity";
import { WalletActivityTable } from "./wallet-activity-table";
import {
  activityDisplayId,
  type IssuedTokensByMint,
  symbolsByMint,
  type WalletBalancesResult,
  walletTransactionsHref,
} from "./wallet-detail.shared";
import { EmptyNote } from "./wallet-overview-tab";

/** How many more rows each "Load older activity" asks the feed for. */
const WALLET_ACTIVITY_LOAD_STEP = 100;

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
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
  const [limit, setLimit] = useState(WALLET_ACTIVITY_LIMIT);
  const { data, error, isLoading } = useWalletActivity(walletId, limit);
  const [query, setQuery] = useState("");
  const [type, setType] = useState<string | undefined>();
  const [status, setStatus] = useState<string | undefined>();
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);
  const feedRows = data?.activityRows;
  const rows = useMemo(() => feedRows ?? [], [feedRows]);
  const types = useMemo(() => distinct(rows.map((row) => row.operationLabel)), [rows]);
  const statuses = useMemo(() => distinct(rows.map((row) => row.status)), [rows]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
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
    });
  }, [rows, query, type, status]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visible = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const resetPage =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      setPage(1);
    };

  if (!data && !error) {
    return <div className="h-40 animate-pulse rounded-control bg-fill-subtle" aria-hidden="true" />;
  }
  if ((error && !data) || data?.activityError) {
    return (
      <p className="text-body text-tertiary">
        {data?.activityError ?? t("DashboardCustody.walletActivityUnavailable")}
      </p>
    );
  }
  if (rows.length === 0) {
    return (
      <EmptyNote title={t("DashboardCustody.walletNoActivityTitle")}>
        {t("DashboardCustody.walletNoActivityTabBody")}
      </EmptyNote>
    );
  }

  const anyLabel = t("Shared.SharedComponents.any");
  const hasOlder = data?.hasMore === true;
  // A widened window keeps the narrower one's rows on screen while it loads.
  const loadingOlder = isLoading && data !== undefined;
  const canLoadOlder = hasOlder && limit < WALLET_ACTIVITY_MAX_LIMIT && currentPage === pageCount;
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
                    options={types.map((value) => ({ value, label: value }))}
                    onChange={(value) => resetPage(setType)(value ?? undefined)}
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
                    options={statuses.map((value) => ({ value, label: toTitleCase(value) }))}
                    onChange={(value) => resetPage(setStatus)(value ?? undefined)}
                  />
                ),
              },
            ]}
          />
        }
      >
        <RowsPerPageSelect value={pageSize} onChange={resetPage(setPageSize)} />
        <SearchInput
          value={query}
          onChange={(event) => resetPage(setQuery)(event.target.value)}
          clear={{
            label: t("DashboardCustody.walletClearActivitySearch"),
            onClear: () => resetPage(setQuery)(""),
          }}
          placeholder={t("DashboardCustody.walletSearchActivity")}
          className="min-w-0 flex-1 sm:w-56 sm:flex-none"
        />
      </ListToolbar>
      {data?.activityNotice ? (
        <p className="text-meta text-tertiary">{data.activityNotice}</p>
      ) : null}
      {error ? (
        <p className="text-meta text-tertiary">{t("DashboardCustody.walletActivityUnavailable")}</p>
      ) : null}
      {hasOlder ? (
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
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setQuery("");
              setType(undefined);
              setStatus(undefined);
              setPage(1);
            }}
          >
            {t("DashboardCustody.walletClearFilters")}
          </Button>
        </div>
      ) : (
        <WalletActivityTable rows={visible} symbols={symbols} />
      )}
      {filtered.length > pageSize ? (
        <ArrowPagination page={currentPage} pageCount={pageCount} onPageChange={setPage} />
      ) : null}
      {canLoadOlder ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-center"
          disabled={loadingOlder}
          onClick={() =>
            setLimit((current) =>
              Math.min(WALLET_ACTIVITY_MAX_LIMIT, current + WALLET_ACTIVITY_LOAD_STEP)
            )
          }
          data-wallet-activity-load-older
        >
          {t("DashboardCustody.walletActivityLoadOlder")}
        </Button>
      ) : null}
    </div>
  );
}
