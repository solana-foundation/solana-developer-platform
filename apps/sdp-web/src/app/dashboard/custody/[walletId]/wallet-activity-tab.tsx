"use client";

import { use, useMemo, useState } from "react";
import { ArrowPagination } from "@/components/ui/arrow-pagination";
import { Button } from "@/components/ui/button";
import { FilterMenu, FilterMenuOptions } from "@/components/ui/filter-menu";
import { ListToolbar, RowsPerPageSelect } from "@/components/ui/list-toolbar";
import { SearchInput } from "@/components/ui/search-input";
import { useTranslations } from "@/i18n/provider";
import { toTitleCase } from "../../activity-format-utils";
import { useWalletActivity } from "./use-wallet-activity";
import { activityDisplayId, WalletActivityTable } from "./wallet-activity-table";
import {
  type IssuedTokensByMint,
  symbolsByMint,
  type WalletBalancesResult,
} from "./wallet-detail.shared";
import { EmptyNote } from "./wallet-overview-tab";

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

/**
 * Everything the wallet signed that the feed returns, searchable and filterable by type and
 * status, a page at a time.
 */
export function WalletActivityTab({
  walletId,
  balancesPromise,
  issuedTokensPromise,
}: {
  walletId: string;
  balancesPromise: Promise<WalletBalancesResult>;
  issuedTokensPromise: Promise<IssuedTokensByMint>;
}) {
  const t = useTranslations();
  const { balances } = use(balancesPromise);
  const issued = use(issuedTokensPromise);
  const symbols = useMemo(() => symbolsByMint(balances, issued), [balances, issued]);
  const { data, error } = useWalletActivity(walletId);
  const [query, setQuery] = useState("");
  const [type, setType] = useState<string | undefined>();
  const [status, setStatus] = useState<string | undefined>();
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);
  const rows = data?.activityRows ?? [];
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
  if (error || data?.activityError) {
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
    </div>
  );
}
