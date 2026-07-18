"use client";

import type {
  Counterparty,
  ListCounterpartiesResponse,
  PaymentsDashboardWalletsEnvelope,
} from "@sdp/types";
import { FilterIcon, SearchIcon, XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { useDebounce } from "@/lib/use-debounce";
import { cn } from "@/lib/utils";
import {
  countActiveTransactionFilters,
  serializeTransactionFilters,
  TRANSACTION_STATUSES,
  TRANSACTION_TYPES,
  type TransactionFilters,
  type TransactionSortField,
  type TransactionStatusFilter,
  type TransactionTypeFilter,
} from "./transactions-query";

interface TransactionFilterContextValue {
  filters: TransactionFilters;
  isPending: boolean;
  updateFilters: (
    changes: Partial<TransactionFilters>,
    options?: { preserveSnapshot?: boolean }
  ) => void;
}

const TransactionFilterContext = createContext<TransactionFilterContextValue | null>(null);

export function useTransactionFilters(): TransactionFilterContextValue {
  const value = useContext(TransactionFilterContext);
  if (!value) throw new Error("Transaction filter context is missing");
  return value;
}

const STATUS_LABELS = {
  pending: "DashboardPayments.transactions.pending",
  processing: "DashboardPayments.transactions.processing",
  confirmed: "DashboardPayments.transactions.confirmed",
  finalized: "DashboardPayments.transactions.finalized",
  failed: "DashboardPayments.transactions.failed",
  awaiting_payment: "DashboardPayments.transactions.awaitingPayment",
  settling: "DashboardPayments.transactions.settling",
  completed: "DashboardPayments.transactions.completed",
  canceled: "DashboardPayments.transactions.canceled",
  expired: "DashboardPayments.transactions.expired",
} as const satisfies Record<TransactionStatusFilter, MessageKey>;

const TYPE_LABELS = {
  transfer: "DashboardPayments.transactions.transfer",
  transfer_confidential: "DashboardPayments.transactions.confidentialTransfer",
  transfer_batch: "DashboardPayments.transactions.batchTransfer",
  onramp: "DashboardPayments.transactions.onramp",
  offramp: "DashboardPayments.transactions.offramp",
} as const satisfies Record<TransactionTypeFilter, MessageKey>;

interface FilterOptions {
  wallets: Array<{ id: string; label: string }>;
  counterparties: Array<{ id: string; label: string }>;
}

async function fetchFilterOptions(): Promise<FilterOptions> {
  const [walletsResponse, counterpartiesResponse] = await Promise.all([
    fetch("/api/dashboard/wallets?view=summary&pageSize=50", { cache: "no-store" }),
    fetch("/api/dashboard/counterparty?page=1&pageSize=50", { cache: "no-store" }),
  ]);
  if (!walletsResponse.ok || !counterpartiesResponse.ok) {
    throw new Error("Transaction filter options could not be loaded");
  }
  const walletsBody = (await walletsResponse
    .json()
    .catch(() => ({}))) as PaymentsDashboardWalletsEnvelope;
  const counterpartiesBody = (await counterpartiesResponse.json().catch(() => ({}))) as {
    data?: ListCounterpartiesResponse;
  };

  return {
    wallets: (walletsBody.data?.wallets ?? []).map((wallet) => ({
      id: wallet.walletId,
      label: wallet.label?.trim() || wallet.publicKey,
    })),
    counterparties: (counterpartiesBody.data?.counterparties ?? []).map(
      (counterparty: Counterparty) => ({
        id: counterparty.id,
        label: counterparty.displayName,
      })
    ),
  };
}

function AssetFilter({
  value,
  updateFilters,
}: {
  value: string | undefined;
  updateFilters: TransactionFilterContextValue["updateFilters"];
}) {
  const t = useTranslations();
  const [inputValue, setInputValue] = useState(value ?? "");
  const debouncedValue = useDebounce(inputValue.trim(), 300);

  useEffect(() => setInputValue(value ?? ""), [value]);
  useEffect(() => {
    if (debouncedValue === (value ?? "")) return;
    updateFilters({ asset: debouncedValue || undefined });
  }, [debouncedValue, updateFilters, value]);

  return (
    <Input
      value={inputValue}
      onChange={(event) => setInputValue(event.target.value)}
      placeholder={t("DashboardPayments.transactions.assetPlaceholder")}
      aria-label={t("DashboardPayments.transactions.assetPlaceholder")}
    />
  );
}

function buildTransactionsHref(filters: TransactionFilters): string {
  const query = serializeTransactionFilters(filters).toString();
  return `/dashboard/payments/transactions${query ? `?${query}` : ""}`;
}

function SelectFilter({
  value,
  allLabel,
  ariaLabel,
  onChange,
  children,
}: {
  value?: string;
  allLabel: string;
  ariaLabel: string;
  onChange: (value: string | undefined) => void;
  children: ReactNode;
}) {
  return (
    <Select
      value={value ?? "all"}
      ariaLabel={ariaLabel}
      onValueChange={(next) => onChange(!next || next === "all" ? undefined : next)}
    >
      <SelectItem value="all">{allLabel}</SelectItem>
      {children}
    </Select>
  );
}

function AdvancedFilters({
  filters,
  options,
  optionsLoading,
  updateFilters,
}: {
  filters: TransactionFilters;
  options: FilterOptions | undefined;
  optionsLoading: boolean;
  updateFilters: TransactionFilterContextValue["updateFilters"];
}) {
  const t = useTranslations();
  const wallets = [...(options?.wallets ?? [])];
  const counterparties = [...(options?.counterparties ?? [])];
  if (filters.walletId && !wallets.some((option) => option.id === filters.walletId)) {
    wallets.unshift({ id: filters.walletId, label: filters.walletId });
  }
  if (
    filters.counterpartyId &&
    !counterparties.some((option) => option.id === filters.counterpartyId)
  ) {
    counterparties.unshift({ id: filters.counterpartyId, label: filters.counterpartyId });
  }

  return (
    <div
      className="grid gap-2 border-t border-border-default bg-fill-subtle p-3 sm:grid-cols-2 xl:grid-cols-4"
      data-transaction-advanced-filters
    >
      <SelectFilter
        value={filters.type}
        allLabel={t("DashboardPayments.transactions.allTypes")}
        ariaLabel={t("DashboardPayments.transactions.allTypes")}
        onChange={(type) => updateFilters({ type: type as TransactionTypeFilter | undefined })}
      >
        {TRANSACTION_TYPES.map((type) => (
          <SelectItem key={type} value={type}>
            {t(TYPE_LABELS[type])}
          </SelectItem>
        ))}
      </SelectFilter>
      <SelectFilter
        value={filters.direction}
        allLabel={t("DashboardPayments.transactions.allDirections")}
        ariaLabel={t("DashboardPayments.transactions.allDirections")}
        onChange={(direction) =>
          updateFilters({ direction: direction as "inbound" | "outbound" | undefined })
        }
      >
        <SelectItem value="inbound">{t("DashboardPayments.transactions.inbound")}</SelectItem>
        <SelectItem value="outbound">{t("DashboardPayments.transactions.outbound")}</SelectItem>
      </SelectFilter>
      <SelectFilter
        value={filters.walletId}
        allLabel={
          optionsLoading
            ? t("DashboardPayments.transactions.loadingOptions")
            : t("DashboardPayments.transactions.allWallets")
        }
        ariaLabel={t("DashboardPayments.transactions.allWallets")}
        onChange={(walletId) => updateFilters({ walletId })}
      >
        {wallets.map((wallet) => (
          <SelectItem key={wallet.id} value={wallet.id}>
            {wallet.label}
          </SelectItem>
        ))}
      </SelectFilter>
      <SelectFilter
        value={filters.counterpartyId}
        allLabel={
          optionsLoading
            ? t("DashboardPayments.transactions.loadingOptions")
            : t("DashboardPayments.transactions.allCounterparties")
        }
        ariaLabel={t("DashboardPayments.transactions.allCounterparties")}
        onChange={(counterpartyId) => updateFilters({ counterpartyId })}
      >
        {counterparties.map((counterparty) => (
          <SelectItem key={counterparty.id} value={counterparty.id}>
            {counterparty.label}
          </SelectItem>
        ))}
      </SelectFilter>
      <SelectFilter
        value={filters.provider}
        allLabel={t("DashboardPayments.transactions.allProviders")}
        ariaLabel={t("DashboardPayments.transactions.allProviders")}
        onChange={(provider) => updateFilters({ provider })}
      >
        {["moonpay", "lightspark", "bvnk", "moneygram", "coinbase", "mural", "stripe"].map(
          (provider) => (
            <SelectItem key={provider} value={provider}>
              {provider === "bvnk" ? "BVNK" : provider[0]?.toUpperCase() + provider.slice(1)}
            </SelectItem>
          )
        )}
      </SelectFilter>
      <AssetFilter value={filters.asset} updateFilters={updateFilters} />
      <Input
        type="date"
        value={filters.from ?? ""}
        onChange={(event) => updateFilters({ from: event.target.value || undefined })}
        aria-label={t("DashboardPayments.transactions.fromDate")}
      />
      <Input
        type="date"
        value={filters.to ?? ""}
        onChange={(event) => updateFilters({ to: event.target.value || undefined })}
        aria-label={t("DashboardPayments.transactions.toDate")}
      />
    </div>
  );
}

export function TransactionsWorkspace({
  filters,
  children,
}: {
  filters: TransactionFilters;
  children: ReactNode;
}) {
  const t = useTranslations();
  const router = useRouter();
  const { selectedProjectId } = useDashboardWorkspace();
  const stateRef = useRef(filters);
  const transitionStartedAt = useRef<number | null>(null);
  const [displayFilters, setDisplayFilters] = useState(filters);
  const [searchValue, setSearchValue] = useState(filters.search ?? "");
  const [isPending, startTransition] = useTransition();
  const advancedFilterCount = countActiveTransactionFilters(displayFilters);
  const hasAdvancedFilter = Boolean(
    displayFilters.direction ||
      displayFilters.type ||
      displayFilters.walletId ||
      displayFilters.counterpartyId ||
      displayFilters.asset ||
      displayFilters.provider ||
      displayFilters.from ||
      displayFilters.to
  );
  const [filtersOpen, setFiltersOpen] = useState(hasAdvancedFilter);
  const debouncedSearch = useDebounce(searchValue.trim(), 300);
  const { data: filterOptions, isLoading: optionsLoading } = useSWR<FilterOptions>(
    filtersOpen && selectedProjectId
      ? ["payments-transaction-filter-options-v1", selectedProjectId]
      : null,
    fetchFilterOptions,
    { dedupingInterval: 60_000, revalidateOnFocus: false }
  );

  useEffect(() => {
    stateRef.current = filters;
    setDisplayFilters(filters);
    setSearchValue(filters.search ?? "");
  }, [filters]);

  useEffect(() => {
    if (isPending || transitionStartedAt.current === null) return;
    console.info(
      JSON.stringify({
        event: "sdp_web_ui_transition",
        surface: "payments_transactions",
        durationMs: Math.round((performance.now() - transitionStartedAt.current) * 10) / 10,
      })
    );
    transitionStartedAt.current = null;
  }, [isPending]);

  const updateFilters = useCallback(
    (changes: Partial<TransactionFilters>, options: { preserveSnapshot?: boolean } = {}) => {
      const current = stateRef.current;
      const onlyPagination = Object.keys(changes).every(
        (key) => key === "page" || key === "pageSize"
      );
      const next: TransactionFilters = {
        ...current,
        ...changes,
        ...(!("page" in changes) && !onlyPagination ? { page: 1 } : {}),
        ...(!options.preserveSnapshot && !onlyPagination
          ? { snapshot: new Date().toISOString() }
          : {}),
      };
      stateRef.current = next;
      setDisplayFilters(next);
      transitionStartedAt.current = performance.now();
      startTransition(() => router.replace(buildTransactionsHref(next), { scroll: false }));
    },
    [router]
  );

  useEffect(() => {
    if (debouncedSearch === (stateRef.current.search ?? "")) return;
    updateFilters({ search: debouncedSearch || undefined });
  }, [debouncedSearch, updateFilters]);

  const clearFilters = () => {
    setSearchValue("");
    setFiltersOpen(false);
    updateFilters({
      search: undefined,
      status: undefined,
      direction: undefined,
      type: undefined,
      walletId: undefined,
      counterpartyId: undefined,
      asset: undefined,
      provider: undefined,
      from: undefined,
      to: undefined,
      sortBy: "createdAt",
      sortDirection: "desc",
      page: 1,
      pageSize: 25,
    });
  };
  const sortValue = `${displayFilters.sortBy}:${displayFilters.sortDirection}`;

  return (
    <TransactionFilterContext.Provider
      value={{ filters: displayFilters, isPending, updateFilters }}
    >
      <div className="h-full min-h-0 overflow-y-auto px-3 pt-5 pb-6 md:px-6">
        <div className="overflow-hidden rounded-lg border border-border-default bg-white">
          <div className="border-b border-border-default p-3">
            <div className="grid gap-2 lg:grid-cols-[minmax(280px,1fr)_190px_190px_auto]">
              <Input
                value={searchValue}
                onChange={(event) => setSearchValue(event.target.value)}
                placeholder={t("DashboardPayments.transactions.searchPlaceholder")}
                aria-label={t("DashboardPayments.transactions.searchPlaceholder")}
                iconLeft={<SearchIcon />}
                iconRight={
                  searchValue ? (
                    <button
                      type="button"
                      aria-label={t("DashboardPayments.transactions.clearSearch")}
                      onClick={() => setSearchValue("")}
                      className="rounded text-tertiary hover:text-primary"
                    >
                      <XIcon />
                    </button>
                  ) : undefined
                }
              />
              <SelectFilter
                value={displayFilters.status}
                allLabel={t("DashboardPayments.transactions.allStatuses")}
                ariaLabel={t("DashboardPayments.transactions.allStatuses")}
                onChange={(status) =>
                  updateFilters({ status: status as TransactionStatusFilter | undefined })
                }
              >
                {TRANSACTION_STATUSES.map((status) => (
                  <SelectItem key={status} value={status}>
                    {t(STATUS_LABELS[status])}
                  </SelectItem>
                ))}
              </SelectFilter>
              <Select
                value={sortValue}
                ariaLabel={t("DashboardPayments.transactions.sort")}
                onValueChange={(value) => {
                  const [sortBy = "createdAt", sortDirection = "desc"] = (value ?? "").split(":");
                  updateFilters({
                    sortBy: sortBy as TransactionSortField,
                    sortDirection: sortDirection as "asc" | "desc",
                  });
                }}
              >
                <SelectItem value="createdAt:desc">
                  {t("DashboardPayments.transactions.newest")}
                </SelectItem>
                <SelectItem value="createdAt:asc">
                  {t("DashboardPayments.transactions.oldest")}
                </SelectItem>
                <SelectItem value="amount:desc">
                  {t("DashboardPayments.transactions.amountHigh")}
                </SelectItem>
                <SelectItem value="amount:asc">
                  {t("DashboardPayments.transactions.amountLow")}
                </SelectItem>
                <SelectItem value="status:asc">
                  {t("DashboardPayments.transactions.statusAscending")}
                </SelectItem>
              </Select>
              <Button
                type="button"
                variant={filtersOpen ? "secondary" : "outline"}
                iconLeft={<FilterIcon />}
                aria-expanded={filtersOpen}
                aria-controls="payments-transaction-advanced-filters"
                onClick={() => setFiltersOpen((open) => !open)}
              >
                {t("DashboardPayments.transactions.filters")}
                {advancedFilterCount > 0 ? (
                  <span className="rounded-full bg-primary px-1.5 py-0.5 text-[11px] text-white">
                    {advancedFilterCount}
                  </span>
                ) : null}
              </Button>
            </div>
            {advancedFilterCount > 0 ? (
              <div className="mt-2 flex items-center justify-between gap-3">
                <span className="text-xs text-secondary">
                  {t("DashboardPayments.transactions.activeFilters", {
                    count: advancedFilterCount,
                  })}
                </span>
                <Button type="button" variant="link" size="sm" onClick={clearFilters}>
                  {t("DashboardPayments.transactions.clearFilters")}
                </Button>
              </div>
            ) : null}
          </div>
          <div id="payments-transaction-advanced-filters" className={cn(!filtersOpen && "hidden")}>
            <AdvancedFilters
              filters={displayFilters}
              options={filterOptions}
              optionsLoading={optionsLoading}
              updateFilters={updateFilters}
            />
          </div>
          {children}
        </div>
      </div>
    </TransactionFilterContext.Provider>
  );
}
