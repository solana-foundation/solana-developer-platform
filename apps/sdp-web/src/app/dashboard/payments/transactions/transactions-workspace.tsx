"use client";

import {
  UNIFIED_TRANSACTION_MODULE_CONTRACTS,
  UNIFIED_TRANSACTION_MODULES,
  UNIFIED_TRANSACTION_STATUSES,
  WELL_KNOWN_TOKENS,
} from "@sdp/types";
import { ReceiptTextIcon, XIcon } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import useSWR from "swr";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { FilterMenu, FilterMenuOptions, type FilterMenuSection } from "@/components/ui/filter-menu";
import { ListEmptyState } from "@/components/ui/list-empty-state";
import { ListToolbar, RowsPerPageSelect } from "@/components/ui/list-toolbar";
import { SearchInput } from "@/components/ui/search-input";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { replaceDashboardSearchParams } from "@/lib/dashboard-url-state";
import { useSolanaCluster } from "@/lib/use-solana-cluster";
import { shortenAddress } from "../payments-overview.utils";
import type { PaymentsIssuedTokenSymbol } from "../payments-page.data";
import { paymentsQueryKeys } from "../payments-query-key";
import { TransactionsResultsSkeleton } from "../payments-route-skeletons";
import {
  fetchTransactionsPageFromDashboard,
  type TransactionsPageResult,
  transactionsApiQuery,
} from "./transactions-page.data";
import {
  DEFAULT_TRANSACTION_PAGE_SIZE,
  parseTransactionModule,
  TRANSACTION_PAGE_SIZES,
  type TransactionFilters,
  toTransactionUrlUpdates,
} from "./transactions-query";
import { TransactionsResults } from "./transactions-results";

export interface TransactionWalletOption {
  id: string;
  label: string | null;
  publicKey: string;
}

export interface TransactionCounterpartyOption {
  id: string;
  name: string;
}

interface TransactionContextValue {
  filters: TransactionFilters;
  pending: boolean;
  /** Replaces the whole filter set, cursors included; pagination's entry point. */
  navigate: (next: TransactionFilters) => void;
  /** Applies filter changes and drops back to the first page. */
  update: (changes: Partial<TransactionFilters>) => void;
}

const TransactionContext = createContext<TransactionContextValue | null>(null);

/** The two ends of the Date filter's range, as transaction query keys. */
const DATE_BOUNDS = ["from", "to"] as const;

export function useTransactionFilters(): TransactionContextValue {
  const value = useContext(TransactionContext);
  if (value === null) throw new Error("Transaction filter context is missing");
  return value;
}

/** "module:kind" for one kind, "module:" for every kind in a module. */
function typeOptionValue(filters: Pick<TransactionFilters, "module" | "kind">) {
  return filters.module === undefined ? undefined : `${filters.module}:${filters.kind ?? ""}`;
}

function TransactionSearch({
  initialValue,
  onCommit,
}: {
  initialValue: string;
  onCommit: (value: string) => void;
}) {
  const t = useTranslations();
  const [value, setValue] = useState(initialValue);
  return (
    <SearchInput
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => onCommit(value)}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        onCommit(value);
      }}
      clear={{
        label: t("DashboardPayments.transactions.clearSearch"),
        onClear: () => {
          setValue("");
          onCommit("");
        },
      }}
      placeholder={t("DashboardPayments.transactions.searchIdOrSignature")}
      aria-label={t("DashboardPayments.transactions.searchTransactions")}
      className="min-w-0 flex-1 sm:w-56 sm:flex-none"
    />
  );
}

export function TransactionsWorkspace({
  initialFilters,
  initialResult,
  issuedTokensByMint,
  wallets,
  counterparties,
}: {
  initialFilters: TransactionFilters;
  initialResult: TransactionsPageResult;
  issuedTokensByMint: Record<string, PaymentsIssuedTokenSymbol>;
  wallets: readonly TransactionWalletOption[];
  counterparties: readonly TransactionCounterpartyOption[];
}) {
  const t = useTranslations();
  const cluster = useSolanaCluster();
  const [filters, setFilters] = useState(initialFilters);
  const [initialQuery] = useState(() => transactionsApiQuery(initialFilters));

  const navigate = useCallback((next: TransactionFilters) => {
    setFilters(next);
    replaceDashboardSearchParams(toTransactionUrlUpdates(next));
  }, []);
  const update = useCallback(
    (changes: Partial<TransactionFilters>) =>
      navigate({ ...filters, ...changes, cursor: undefined, cursors: [] }),
    [filters, navigate]
  );

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
  const contextValue = useMemo(
    () => ({ filters, pending: isValidating, navigate, update }),
    [filters, isValidating, navigate, update]
  );

  const counterpartyNames = useMemo(
    () => new Map(counterparties.map((counterparty) => [counterparty.id, counterparty.name])),
    [counterparties]
  );
  const walletOptions = wallets.map((wallet) => ({
    value: wallet.id,
    label: wallet.label ?? shortenAddress(wallet.publicKey),
  }));
  const tokenOptions = [
    ...Object.values(WELL_KNOWN_TOKENS).flatMap((token) => {
      const mint = token.mints[cluster as keyof typeof token.mints];
      return mint ? [{ value: mint.address, label: token.symbol }] : [];
    }),
    ...Object.values(issuedTokensByMint).map((token) => ({
      value: token.mintAddress,
      label: token.symbol,
    })),
  ];
  const moduleLabel = (module: (typeof UNIFIED_TRANSACTION_MODULES)[number]) =>
    t(`DashboardPayments.transactions.modules.${module}` as MessageKey);
  const typeOptions = UNIFIED_TRANSACTION_MODULES.flatMap((module) => [
    { value: `${module}:`, label: moduleLabel(module) },
    ...UNIFIED_TRANSACTION_MODULE_CONTRACTS[module].kinds.map((kind) => ({
      value: `${module}:${kind}`,
      label: `${moduleLabel(module)} · ${t(
        `DashboardPayments.transactions.kinds.${module}.${kind}` as MessageKey
      )}`,
    })),
  ]);
  const labelOf = (options: readonly { value: string; label: string }[], value?: string) =>
    value === undefined
      ? undefined
      : (options.find((option) => option.value === value)?.label ?? shortenAddress(value));
  const statusLabel = (status: string) =>
    t(`DashboardPayments.transactions.statuses.${status}` as MessageKey);
  const dateLabel =
    filters.from === undefined && filters.to === undefined
      ? undefined
      : `${filters.from ?? "…"} – ${filters.to ?? "…"}`;
  const anyLabel = t("Shared.SharedComponents.any");

  const sections: FilterMenuSection[] = [
    {
      id: "state",
      label: t("DashboardPayments.transactions.filterState"),
      value: filters.status === undefined ? undefined : statusLabel(filters.status),
      content: (
        <FilterMenuOptions
          value={filters.status}
          anyLabel={anyLabel}
          options={UNIFIED_TRANSACTION_STATUSES.map((status) => ({
            value: status,
            label: statusLabel(status),
          }))}
          onChange={(value) =>
            update({ status: UNIFIED_TRANSACTION_STATUSES.find((status) => status === value) })
          }
        />
      ),
    },
    {
      id: "type",
      label: t("DashboardPayments.transactions.filterType"),
      value: labelOf(typeOptions, typeOptionValue(filters)),
      content: (
        <FilterMenuOptions
          value={typeOptionValue(filters)}
          anyLabel={anyLabel}
          options={typeOptions}
          onChange={(value) => {
            const [module, kind] = (value ?? "").split(":");
            update({ module: parseTransactionModule(module), kind: kind || undefined });
          }}
        />
      ),
    },
    {
      id: "wallet",
      label: t("DashboardPayments.transactions.filterWallet"),
      value: labelOf(walletOptions, filters.custodyWalletId),
      content: (
        <FilterMenuOptions
          value={filters.custodyWalletId}
          anyLabel={anyLabel}
          options={walletOptions}
          onChange={(value) => update({ custodyWalletId: value })}
        />
      ),
    },
    {
      id: "token",
      label: t("DashboardPayments.transactions.filterToken"),
      value: labelOf(tokenOptions, filters.token),
      content: (
        <FilterMenuOptions
          value={filters.token}
          anyLabel={anyLabel}
          options={tokenOptions}
          onChange={(value) => update({ token: value })}
        />
      ),
    },
    {
      id: "contact",
      label: t("DashboardPayments.transactions.filterContact"),
      value:
        filters.counterpartyId === undefined
          ? undefined
          : (counterpartyNames.get(filters.counterpartyId) ??
            shortenAddress(filters.counterpartyId)),
      content: (
        <FilterMenuOptions
          value={filters.counterpartyId}
          anyLabel={anyLabel}
          options={counterparties.map((counterparty) => ({
            value: counterparty.id,
            label: counterparty.name,
          }))}
          onChange={(value) => update({ counterpartyId: value })}
        />
      ),
    },
    {
      id: "date",
      label: t("DashboardPayments.transactions.filterDate"),
      value: dateLabel,
      content: (
        // Native date fields rather than a calendar popover: a popover inside a menu fights
        // the menu for focus. Keydowns stay here so typing a date does not trigger typeahead.
        // biome-ignore lint/a11y/noStaticElementInteractions: Only stops keydown propagation to the menu.
        <div className="grid gap-3 p-2" onKeyDown={(event) => event.stopPropagation()}>
          {DATE_BOUNDS.map((bound) => (
            <label key={bound} className="grid gap-1 text-meta text-secondary">
              {t(
                bound === "from"
                  ? "DashboardPayments.transactions.fromDate"
                  : "DashboardPayments.transactions.toDate"
              )}
              <input
                type="date"
                value={filters[bound] ?? ""}
                onChange={(event) => update({ [bound]: event.currentTarget.value || undefined })}
                className="h-9 border-b border-border-default bg-transparent text-body text-primary outline-none focus:border-primary dark:[color-scheme:dark]"
              />
            </label>
          ))}
        </div>
      ),
    },
  ];

  const activeChips = sections.flatMap((section) =>
    section.value === undefined
      ? []
      : [
          {
            id: section.id,
            label: section.label,
            value: section.value,
            clear: () =>
              update(
                section.id === "state"
                  ? { status: undefined }
                  : section.id === "type"
                    ? { module: undefined, kind: undefined }
                    : section.id === "wallet"
                      ? { custodyWalletId: undefined }
                      : section.id === "token"
                        ? { token: undefined }
                        : section.id === "contact"
                          ? { counterpartyId: undefined }
                          : { from: undefined, to: undefined }
              ),
          },
        ]
  );
  const searchValue = filters.search === undefined ? "" : filters.search;

  return (
    <TransactionContext.Provider value={contextValue}>
      <DashboardWorkspaceOverviewPanel className="flex flex-col gap-5" aria-busy={isValidating}>
        <ListToolbar
          filters={
            <FilterMenu
              label={t("Shared.SharedComponents.filter")}
              searchPlaceholder={t("Shared.SharedComponents.filterBy")}
              sections={sections}
            />
          }
        >
          <RowsPerPageSelect
            value={filters.pageSize ?? DEFAULT_TRANSACTION_PAGE_SIZE}
            sizes={TRANSACTION_PAGE_SIZES}
            onChange={(pageSize) => update({ pageSize })}
          />
          <TransactionSearch key={searchValue} initialValue={searchValue} onCommit={commitSearch} />
        </ListToolbar>
        {activeChips.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            {activeChips.map((chip) => (
              <span
                key={chip.id}
                className="inline-flex h-7 items-center gap-1.5 rounded-control bg-fill-subtle pr-1 pl-2.5 text-meta text-secondary"
              >
                {chip.label}: <span className="text-primary">{chip.value}</span>
                <button
                  type="button"
                  aria-label={t("Shared.SharedComponents.clearFilter", { filter: chip.label })}
                  onClick={chip.clear}
                  className="rounded-control-inner p-0.5 text-tertiary hover:bg-fill hover:text-primary"
                >
                  <XIcon className="size-3.5" aria-hidden="true" />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        {error !== undefined ? (
          <ListEmptyState
            icon={<ReceiptTextIcon className="size-5" />}
            message={t("DashboardPayments.transactions.loadFailed")}
            description={error.message}
          />
        ) : data === undefined ? (
          <TransactionsResultsSkeleton />
        ) : (
          <TransactionsResults
            result={data}
            issuedTokensByMint={issuedTokensByMint}
            counterpartyNames={counterpartyNames}
          />
        )}
      </DashboardWorkspaceOverviewPanel>
    </TransactionContext.Provider>
  );
}
