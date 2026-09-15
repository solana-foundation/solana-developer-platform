"use client";

import { UNIFIED_TRANSACTION_MODULE_CONTRACTS, UNIFIED_TRANSACTION_STATUSES } from "@sdp/types";
import { ReceiptTextIcon, SearchIcon, XIcon } from "lucide-react";
import {
  createContext,
  type KeyboardEvent,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import useSWR from "swr";
import {
  DashboardWorkspaceCard,
  DashboardWorkspaceOverviewPanel,
} from "@/components/dashboard-workspace-panel";
import { EntityLink } from "@/components/entity-link";
import { DateRangePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import { ListEmptyState } from "@/components/ui/list-empty-state";
import { Select, SelectItem } from "@/components/ui/select";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import {
  readDashboardTabFromUrl,
  replaceDashboardSearchParams,
  useDashboardTab,
} from "@/lib/dashboard-url-state";
import type { PaymentsIssuedTokenSymbol } from "../payments-page.data";
import { paymentsQueryKeys } from "../payments-query-key";
import { TransactionsResultsSkeleton } from "../payments-route-skeletons";
import {
  fetchTransactionsPageFromDashboard,
  type TransactionsPageResult,
  transactionsApiQuery,
} from "./transactions-page.data";
import {
  parseTransactionModule,
  type TransactionFilters,
  toTransactionUrlUpdates,
} from "./transactions-query";
import { TransactionsResults } from "./transactions-results";

interface TransactionContextValue {
  filters: TransactionFilters;
  pending: boolean;
  /** Replaces the whole filter set, cursors included; pagination's entry point. */
  navigate: (next: TransactionFilters) => void;
  /** Applies filter changes and drops back to the first page. */
  update: (changes: Partial<TransactionFilters>) => void;
}

const TransactionContext = createContext<TransactionContextValue | null>(null);

export function useTransactionFilters(): TransactionContextValue {
  const value = useContext(TransactionContext);
  if (value === null) throw new Error("Transaction filter context is missing");
  return value;
}

function selectedValue(value: string | null | undefined): string | undefined {
  return value === null || value === undefined || value === "all" ? undefined : value;
}

function TransactionSearchInput({
  initialValue,
  onCommit,
}: {
  initialValue: string;
  onCommit: (value: string) => void;
}) {
  const t = useTranslations();
  const [value, setValue] = useState(initialValue);
  return (
    <Input
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => onCommit(value)}
      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        onCommit(value);
      }}
      placeholder={t("DashboardPayments.transactions.searchTransactions")}
      aria-label={t("DashboardPayments.transactions.searchTransactions")}
      iconLeft={<SearchIcon />}
    />
  );
}

export function TransactionsWorkspace({
  initialFilters,
  initialResult,
  issuedTokensByMint,
}: {
  initialFilters: TransactionFilters;
  initialResult: TransactionsPageResult;
  issuedTokensByMint: Record<string, PaymentsIssuedTokenSymbol>;
}) {
  const t = useTranslations();
  const [filters, setFilters] = useState(initialFilters);
  const [initialQuery] = useState(() => transactionsApiQuery(initialFilters));
  const activeModule = parseTransactionModule(useDashboardTab());

  const navigate = useCallback((next: TransactionFilters) => {
    setFilters(next);
    replaceDashboardSearchParams(toTransactionUrlUpdates(next));
  }, []);
  const update = useCallback(
    (changes: Partial<TransactionFilters>) =>
      navigate({ ...filters, ...changes, cursor: undefined, cursors: [] }),
    [filters, navigate]
  );

  // The header tabs own `?tab=` and write it shallowly, so the module is the one
  // filter that arrives from outside this component's state. During hydration
  // the tab store still holds its null server snapshot while the URL already
  // carries the real tab, so the effect defers to the URL until the two agree.
  useEffect(() => {
    if (parseTransactionModule(readDashboardTabFromUrl()) !== activeModule) return;
    if (activeModule !== filters.module) {
      update({ module: activeModule, kind: undefined });
    }
  }, [activeModule, filters.module, update]);

  const apiQuery = transactionsApiQuery(filters);
  const { data, error, isValidating } = useSWR<TransactionsPageResult, Error>(
    paymentsQueryKeys.transactions({ query: apiQuery }),
    ([, query]: readonly [string, string]) => fetchTransactionsPageFromDashboard(query),
    {
      fallbackData: apiQuery === initialQuery ? initialResult : undefined,
      revalidateOnMount: false,
      keepPreviousData: true,
      revalidateOnFocus: false,
    }
  );

  const commitSearch = (value: string) => {
    const trimmed = value.trim();
    if (trimmed.length >= 3) update({ search: trimmed });
    else if (trimmed.length === 0) update({ search: undefined });
  };
  const searchValue = filters.search === undefined ? "" : filters.search;
  const contextValue = useMemo(
    () => ({ filters, pending: isValidating, navigate, update }),
    [filters, isValidating, navigate, update]
  );
  const linkedFilters = [
    {
      key: "counterpartyId",
      label: t("DashboardPayments.transactions.counterparty"),
      value: filters.counterpartyId,
      href: (id: string) => `/dashboard/payments/counterparty/${encodeURIComponent(id)}`,
      clearLabel: t("DashboardPayments.transactions.clearCounterparty"),
    },
    {
      key: "custodyWalletId",
      label: t("DashboardPayments.transactions.wallet"),
      value: filters.custodyWalletId,
      href: (id: string) => `/dashboard/wallets/${encodeURIComponent(id)}`,
      clearLabel: t("DashboardPayments.transactions.clearWallet"),
    },
    {
      key: "token",
      label: t("DashboardPayments.transactions.token"),
      value: filters.token,
      href: null,
      clearLabel: t("DashboardPayments.transactions.clearToken"),
    },
  ] as const;

  return (
    <TransactionContext.Provider value={contextValue}>
      <DashboardWorkspaceOverviewPanel className="flex flex-col" aria-busy={isValidating}>
        <DashboardWorkspaceCard>
          <div className="grid gap-2 border-b border-border-default p-3 md:grid-cols-2 xl:grid-cols-4">
            <TransactionSearchInput
              key={searchValue}
              initialValue={searchValue}
              onCommit={commitSearch}
            />
            {filters.module === undefined ? null : (
              <Select
                value={filters.kind === undefined ? "all" : filters.kind}
                ariaLabel={t("DashboardPayments.transactions.kindSelectLabel")}
                onValueChange={(kind) => update({ kind: selectedValue(kind) })}
              >
                <SelectItem value="all">{t("DashboardPayments.transactions.allKinds")}</SelectItem>
                {UNIFIED_TRANSACTION_MODULE_CONTRACTS[filters.module].kinds.map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {t(
                      `DashboardPayments.transactions.kinds.${filters.module}.${kind}` as MessageKey
                    )}
                  </SelectItem>
                ))}
              </Select>
            )}
            <Select
              value={filters.status === undefined ? "all" : filters.status}
              ariaLabel={t("DashboardPayments.transactions.statusSelectLabel")}
              onValueChange={(value) => {
                const selected = selectedValue(value);
                update({
                  status: UNIFIED_TRANSACTION_STATUSES.find((candidate) => candidate === selected),
                });
              }}
            >
              <SelectItem value="all">{t("DashboardPayments.transactions.allStatuses")}</SelectItem>
              {UNIFIED_TRANSACTION_STATUSES.map((status) => (
                <SelectItem key={status} value={status}>
                  {t(`DashboardPayments.transactions.statuses.${status}` as MessageKey)}
                </SelectItem>
              ))}
            </Select>
            <DateRangePicker
              id="transactions-date-range"
              from={filters.from === undefined ? "" : filters.from}
              to={filters.to === undefined ? "" : filters.to}
              onChange={(from, to) =>
                update({ from: from === "" ? undefined : from, to: to === "" ? undefined : to })
              }
            />
          </div>
          {linkedFilters.map((linked) =>
            linked.value === undefined ? null : (
              <div
                key={linked.key}
                className="flex items-center gap-2 border-b border-border-default px-3 py-2 text-sm"
              >
                <span className="text-secondary">{linked.label}:</span>
                {linked.href === null ? (
                  <span className="text-primary">{linked.value}</span>
                ) : (
                  <EntityLink href={linked.href(linked.value)}>{linked.value}</EntityLink>
                )}
                <button
                  type="button"
                  className="rounded p-1 text-tertiary hover:bg-surface-secondary hover:text-primary"
                  aria-label={linked.clearLabel}
                  onClick={() => update({ [linked.key]: undefined })}
                >
                  <XIcon className="size-4" />
                </button>
              </div>
            )
          )}
          {error !== undefined ? (
            <ListEmptyState
              icon={<ReceiptTextIcon className="size-5" />}
              message={t("DashboardPayments.transactions.loadFailed")}
              description={error.message}
            />
          ) : data === undefined ? (
            <TransactionsResultsSkeleton />
          ) : (
            <TransactionsResults result={data} issuedTokensByMint={issuedTokensByMint} />
          )}
        </DashboardWorkspaceCard>
      </DashboardWorkspaceOverviewPanel>
    </TransactionContext.Provider>
  );
}
