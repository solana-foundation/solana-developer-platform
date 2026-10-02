"use client";

import {
  UNIFIED_TRANSACTION_MODULE_CONTRACTS,
  UNIFIED_TRANSACTION_MODULES,
  UNIFIED_TRANSACTION_STATUSES,
  type UnifiedTransactionModule,
  type UnifiedTransactionStatus,
} from "@sdp/types";
import { use, useMemo, useState } from "react";
import { ArrowPagination } from "@/components/ui/arrow-pagination";
import { Button } from "@/components/ui/button";
import { FilterMenu, FilterMenuOptions } from "@/components/ui/filter-menu";
import { ListToolbar, RowsPerPageSelect } from "@/components/ui/list-toolbar";
import { SearchInput } from "@/components/ui/search-input";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { parseTransactionModule } from "../../payments/transactions/transactions-query.redesign";
import {
  useWalletTransactions,
  WALLET_TRANSACTIONS_SEARCH_MIN_LENGTH,
  WalletTransactionsError,
} from "./use-wallet-transactions";
import { WalletActivityTable } from "./wallet-activity-table";
import {
  type IssuedTokensByMint,
  symbolsByMint,
  type WalletBalancesResult,
} from "./wallet-detail.shared";
import { EmptyNote } from "./wallet-overview-tab";

/** Rows a page of the Activity tab shows until the user picks another size. */
const ACTIVITY_DEFAULT_PAGE_SIZE = 25;

/** The tab's filters and page, every one of them applied by the API. */
interface ActivityListState {
  status?: UnifiedTransactionStatus;
  module?: UnifiedTransactionModule;
  kind?: string;
  /** The search as sent: at least `WALLET_TRANSACTIONS_SEARCH_MIN_LENGTH` characters. */
  search?: string;
  pageSize: number;
  /** The cursor each page after the first was opened with; its length is the page before this. */
  cursors: string[];
}

/**
 * The tab's filters, search and page. Any change to a filter, the search or the size starts
 * over from the newest page, as a cursor only means something within the list it was cut from.
 */
function useActivityListState() {
  const [state, setState] = useState<ActivityListState>({
    pageSize: ACTIVITY_DEFAULT_PAGE_SIZE,
    cursors: [],
  });
  const [query, setQuery] = useState("");
  const update = (changes: Partial<Omit<ActivityListState, "cursors">>) =>
    setState((current) => ({ ...current, ...changes, cursors: [] }));
  return {
    state,
    query,
    hasFilters:
      state.status !== undefined || state.module !== undefined || state.search !== undefined,
    /** The box's text; a search goes to the API from three characters, and clears when emptied. */
    setQuery(value: string) {
      setQuery(value);
      const trimmed = value.trim();
      if (trimmed.length >= WALLET_TRANSACTIONS_SEARCH_MIN_LENGTH) update({ search: trimmed });
      else if (trimmed.length === 0) update({ search: undefined });
    },
    setStatus: (status: UnifiedTransactionStatus | undefined) => update({ status }),
    setType: (module: UnifiedTransactionModule | undefined, kind: string | undefined) =>
      update({ module, kind: module === undefined ? undefined : kind }),
    setPageSize: (pageSize: number) => update({ pageSize }),
    goToPage(target: number, nextCursor: string | null) {
      const page = state.cursors.length + 1;
      if (target === page + 1 && nextCursor !== null) {
        setState((current) => ({ ...current, cursors: [...current.cursors, nextCursor] }));
      } else if (target === page - 1) {
        setState((current) => ({ ...current, cursors: current.cursors.slice(0, -1) }));
      }
    },
    clear() {
      setQuery("");
      setState((current) => ({ pageSize: current.pageSize, cursors: [] }));
    },
  };
}

/**
 * The wallet's activity, newest first, searchable and filterable by type and status, a page at
 * a time. Every control is answered by the API over the wallet's whole history: the search
 * matches an id, signature or counterparty address from its start, the type is a module's kind,
 * and the pages follow the feed's cursor.
 */
export function WalletActivityTab({
  custodyWalletId,
  balancesPromise,
  issuedTokensPromise,
}: {
  custodyWalletId: string;
  balancesPromise: Promise<WalletBalancesResult>;
  issuedTokensPromise: Promise<IssuedTokensByMint>;
}) {
  const t = useTranslations();
  const { balances } = use(balancesPromise);
  const issued = use(issuedTokensPromise);
  const symbols = useMemo(() => symbolsByMint(balances, issued), [balances, issued]);
  const list = useActivityListState();
  const { status, module, kind, search, pageSize, cursors } = list.state;
  const { data, error, isValidating } = useWalletTransactions(
    {
      custodyWalletId,
      limit: pageSize,
      cursor: cursors.at(-1),
      status,
      module,
      kind,
      search,
    },
    // The shown page stays while the next one, or a narrower list, loads.
    { keepPreviousData: true }
  );

  const unavailable =
    error instanceof WalletTransactionsError && error.status === 403
      ? t("DashboardCustody.noActivitySources")
      : t("DashboardCustody.walletActivityUnavailable");
  if (!data) {
    return error ? (
      <p className="text-body text-tertiary">{unavailable}</p>
    ) : (
      <div className="h-40 animate-pulse rounded-control bg-fill-subtle" aria-hidden="true" />
    );
  }
  const rows = data.transactions;
  const page = cursors.length + 1;
  if (rows.length === 0 && !list.hasFilters && page === 1) {
    return (
      <EmptyNote title={t("DashboardCustody.walletNoActivityTitle")}>
        {t("DashboardCustody.walletNoActivityTabBody")}
      </EmptyNote>
    );
  }

  const anyLabel = t("Shared.SharedComponents.any");
  const moduleLabel = (candidate: UnifiedTransactionModule) =>
    t(`DashboardPayments.transactions.modules.${candidate}` as MessageKey);
  const typeOptions = UNIFIED_TRANSACTION_MODULES.flatMap((candidate) => [
    { value: `${candidate}:`, label: moduleLabel(candidate) },
    ...UNIFIED_TRANSACTION_MODULE_CONTRACTS[candidate].kinds.map((candidateKind) => ({
      value: `${candidate}:${candidateKind}`,
      label: `${moduleLabel(candidate)} · ${t(
        `DashboardPayments.transactions.kinds.${candidate}.${candidateKind}` as MessageKey
      )}`,
    })),
  ]);
  const typeValue = module === undefined ? undefined : `${module}:${kind ?? ""}`;
  const statusLabel = (candidate: UnifiedTransactionStatus) =>
    t(`DashboardPayments.transactions.statuses.${candidate}` as MessageKey);
  const pageCount = data.nextCursor === null ? page : page + 1;
  return (
    <div className="flex min-w-0 flex-col gap-5" data-wallet-activity-tab aria-busy={isValidating}>
      <ListToolbar
        filters={
          <FilterMenu
            label={t("Shared.SharedComponents.filter")}
            searchPlaceholder={t("Shared.SharedComponents.filterBy")}
            sections={[
              {
                id: "type",
                label: t("DashboardCustody.walletFilterType"),
                value: typeOptions.find((option) => option.value === typeValue)?.label,
                content: (
                  <FilterMenuOptions
                    value={typeValue}
                    anyLabel={anyLabel}
                    options={typeOptions}
                    onChange={(value) => {
                      const [nextModule, nextKind] = (value ?? "").split(":");
                      list.setType(parseTransactionModule(nextModule), nextKind || undefined);
                    }}
                  />
                ),
              },
              {
                id: "status",
                label: t("DashboardCustody.status"),
                value: status === undefined ? undefined : statusLabel(status),
                content: (
                  <FilterMenuOptions
                    value={status}
                    anyLabel={anyLabel}
                    options={UNIFIED_TRANSACTION_STATUSES.map((candidate) => ({
                      value: candidate,
                      label: statusLabel(candidate),
                    }))}
                    onChange={(value) =>
                      list.setStatus(
                        UNIFIED_TRANSACTION_STATUSES.find((candidate) => candidate === value)
                      )
                    }
                  />
                ),
              },
            ]}
          />
        }
      >
        <RowsPerPageSelect value={pageSize} onChange={list.setPageSize} />
        <SearchInput
          value={list.query}
          onChange={(event) => list.setQuery(event.target.value)}
          clear={{
            label: t("DashboardCustody.walletClearActivitySearch"),
            onClear: () => list.setQuery(""),
          }}
          placeholder={t("DashboardCustody.walletSearchActivity")}
          className="min-w-0 flex-1 sm:w-56 sm:flex-none"
        />
      </ListToolbar>
      {error ? <p className="text-meta text-tertiary">{unavailable}</p> : null}
      {rows.length === 0 ? (
        <div className="flex flex-col items-start gap-4">
          <EmptyNote title={t("DashboardCustody.walletNothingMatches")}>
            {t("DashboardCustody.walletNothingMatchesBody")}
          </EmptyNote>
          <Button type="button" variant="outline" size="sm" onClick={list.clear}>
            {t("DashboardCustody.walletClearFilters")}
          </Button>
        </div>
      ) : (
        <WalletActivityTable rows={rows} symbols={symbols} />
      )}
      {pageCount > 1 ? (
        <ArrowPagination
          page={page}
          pageCount={pageCount}
          disabled={isValidating}
          onPageChange={(target) => list.goToPage(target, data.nextCursor)}
        />
      ) : null}
    </div>
  );
}
