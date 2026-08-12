"use client";

import type { PaymentRecurringPayment, PaymentRecurringPaymentStatus } from "@sdp/types";
import { ChevronRightIcon, PlusIcon, RepeatIcon, SearchIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type KeyboardEvent, useMemo, useState, useTransition } from "react";
import {
  DashboardWorkspaceCard,
  DashboardWorkspaceOverviewPanel,
} from "@/components/dashboard-workspace-panel";
import { EntityLink } from "@/components/entity-link";
import { TokenMark } from "@/components/token-mark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ListEmptyState } from "@/components/ui/list-empty-state";
import { PaginatedFooter } from "@/components/ui/paginated-footer";
import { Select, SelectItem } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTranslations } from "@/i18n/provider";
import {
  formatDisplayAmount,
  resolveTokenByMint,
  shortenAddress,
} from "../payments-overview.utils";
import type { PaymentsIssuedTokenSymbol } from "../payments-page.data";
import {
  RECURRING_LIST_DEFAULT_PAGE_SIZE,
  RECURRING_PAYMENT_STATUSES,
  type RecurringPaymentsListState,
} from "./recurring-payments.data";
import {
  formatOptionalTimestamp,
  formatPeriodHours,
  type RecurringPaymentCounterpartyView,
  RecurringPaymentStatusBadge,
  type RecurringPaymentWalletView,
  resolveTokenLabel,
  STATUS_TRANSLATION_KEYS,
} from "./recurring-payments-shared";
import { RECURRING_NEXT_PAYMENT_COLUMN_VISIBILITY } from "./recurring-payments-table-layout";

interface RecurringPaymentsWorkspaceProps {
  initialRecurringPayments: PaymentRecurringPayment[];
  total: number;
  listState: RecurringPaymentsListState;
  issuedTokensByMint: Record<string, PaymentsIssuedTokenSymbol>;
  initialError?: string;
  lookupError?: string;
  wallets: RecurringPaymentWalletView[];
  counterparties: RecurringPaymentCounterpartyView[];
}

export function RecurringPaymentsWorkspace({
  initialRecurringPayments,
  total,
  listState,
  issuedTokensByMint,
  initialError,
  lookupError,
  wallets,
  counterparties,
}: RecurringPaymentsWorkspaceProps) {
  const t = useTranslations();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [isPending, startTransition] = useTransition();

  /**
   * Applies pagination and status updates to the URL so the server refetches
   * the list. Defaults are dropped from the URL; status changes reset paging.
   *
   * @param updates - The list-state fields to change.
   */
  const applyListParams = (updates: {
    page?: number;
    pageSize?: number;
    status?: PaymentRecurringPaymentStatus | null;
  }) => {
    const params = new URLSearchParams(window.location.search);
    if (updates.page !== undefined) {
      if (updates.page === 1) {
        params.delete("page");
      } else {
        params.set("page", String(updates.page));
      }
    }
    if (updates.pageSize !== undefined) {
      params.delete("page");
      if (updates.pageSize === RECURRING_LIST_DEFAULT_PAGE_SIZE) {
        params.delete("pageSize");
      } else {
        params.set("pageSize", String(updates.pageSize));
      }
    }
    if (updates.status !== undefined) {
      params.delete("page");
      if (updates.status === null) {
        params.delete("status");
      } else {
        params.set("status", updates.status);
      }
    }
    const search = params.toString();
    startTransition(() =>
      router.replace(`/dashboard/payments/recurring${search ? `?${search}` : ""}`, {
        scroll: false,
      })
    );
  };

  const walletById = useMemo(
    () => new Map(wallets.map((wallet) => [wallet.walletId, wallet])),
    [wallets]
  );
  const counterpartyById = useMemo(
    () => new Map(counterparties.map((counterparty) => [counterparty.id, counterparty])),
    [counterparties]
  );

  const getWalletLabel = (recurringPayment: PaymentRecurringPayment) => {
    const wallet = walletById.get(recurringPayment.sourceWalletId);
    return (
      wallet?.label || (wallet ? shortenAddress(wallet.publicKey) : recurringPayment.sourceWalletId)
    );
  };
  const getCounterpartyLabel = (recurringPayment: PaymentRecurringPayment) =>
    counterpartyById.get(recurringPayment.counterpartyId)?.displayName ??
    t("DashboardPayments.recurring.counterpartyUnavailable");
  const getResolvedToken = (recurringPayment: PaymentRecurringPayment) =>
    resolveTokenByMint(
      recurringPayment.token,
      issuedTokensByMint,
      resolveTokenLabel(recurringPayment.token, wallets)
    );
  const getAmountLabel = (recurringPayment: PaymentRecurringPayment) =>
    formatDisplayAmount(recurringPayment.amount, getResolvedToken(recurringPayment).tokenName);

  const needle = query.trim().toLowerCase();
  const visibleRecurringPayments = initialRecurringPayments.filter((recurringPayment) => {
    if (!needle) {
      return true;
    }
    return [
      getCounterpartyLabel(recurringPayment),
      getWalletLabel(recurringPayment),
      resolveTokenLabel(recurringPayment.token, wallets),
    ]
      .join(" ")
      .toLowerCase()
      .includes(needle);
  });

  const clearFilters = () => {
    setQuery("");
    applyListParams({ status: null, page: 1 });
  };

  const pageCount = Math.max(1, Math.ceil(total / listState.pageSize));
  const rangeStart = total === 0 ? 0 : (listState.page - 1) * listState.pageSize + 1;
  const rangeEnd = Math.min(listState.page * listState.pageSize, total);
  const listIsEmpty = total === 0 && listState.status === null;

  return (
    <DashboardWorkspaceOverviewPanel className="flex min-h-0 flex-col overflow-hidden">
      <DashboardWorkspaceCard clamp>
        <div className="border-b border-border-default px-4 py-3">
          <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(160px,1fr)_190px_auto]">
            <Input
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder={t("DashboardPayments.recurring.searchPayments")}
              aria-label={t("DashboardPayments.recurring.searchPayments")}
              iconLeft={<SearchIcon />}
              action={
                query ? (
                  <button
                    type="button"
                    aria-label={t("DashboardPayments.recurring.clearSearch")}
                    onClick={() => setQuery("")}
                    className="rounded text-tertiary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-default"
                  >
                    <XIcon className="size-5" />
                  </button>
                ) : undefined
              }
            />
            <Select
              value={listState.status ?? "all"}
              onValueChange={(value) =>
                applyListParams({
                  status: value === "all" ? null : (value as PaymentRecurringPaymentStatus),
                })
              }
            >
              <SelectItem value="all">{t("DashboardPayments.recurring.allStatuses")}</SelectItem>
              {RECURRING_PAYMENT_STATUSES.map((status) => (
                <SelectItem key={status} value={status}>
                  {t(STATUS_TRANSLATION_KEYS[status])}
                </SelectItem>
              ))}
            </Select>
            {listIsEmpty ? null : (
              <Button asChild size="sm">
                <Link href="/dashboard/payments/recurring/create">
                  <PlusIcon className="size-4" />
                  {t("DashboardPayments.recurring.createPayment")}
                </Link>
              </Button>
            )}
          </div>
        </div>
        {initialError ? (
          <div
            role="alert"
            className="border border-error-border bg-error-bg p-4 text-sm text-error"
          >
            <p className="font-medium">{t("DashboardPayments.recurring.unableToLoad")}</p>
            <p className="mt-1">{initialError}</p>
          </div>
        ) : listIsEmpty ? (
          <ListEmptyState
            icon={<RepeatIcon className="size-5" />}
            message={t("DashboardPayments.recurring.noPayments")}
            description={t("DashboardPayments.recurring.paymentsAppearHere")}
            action={
              <Button asChild size="sm">
                <Link href="/dashboard/payments/recurring/create">
                  <PlusIcon className="size-4" />
                  {t("DashboardPayments.recurring.createPayment")}
                </Link>
              </Button>
            }
          />
        ) : visibleRecurringPayments.length === 0 ? (
          <ListEmptyState
            message={t("DashboardPayments.recurring.noMatches")}
            action={
              <Button type="button" variant="secondary" onClick={clearFilters}>
                {t("DashboardPayments.recurring.clearFilters")}
              </Button>
            }
          />
        ) : (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {lookupError ? <p className="mb-3 text-sm text-warning">{lookupError}</p> : null}
              <div className="divide-y divide-border-default md:hidden">
                {visibleRecurringPayments.map((recurringPayment) => (
                  <button
                    key={recurringPayment.id}
                    type="button"
                    onClick={() =>
                      router.push(
                        `/dashboard/payments/recurring/${encodeURIComponent(recurringPayment.id)}`
                      )
                    }
                    className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-fill-subtle"
                  >
                    <span className="min-w-0 flex-1 space-y-1.5">
                      <span className="flex items-center justify-between gap-3">
                        <RecurringPaymentStatusBadge status={recurringPayment.status} />
                        <span className="truncate text-sm font-medium text-primary">
                          {getAmountLabel(recurringPayment)}
                        </span>
                      </span>
                      <span className="block truncate text-xs text-secondary">
                        {getCounterpartyLabel(recurringPayment)} ·{" "}
                        {getWalletLabel(recurringPayment)}
                      </span>
                    </span>
                    <ChevronRightIcon className="size-4 shrink-0 text-tertiary" />
                  </button>
                ))}
              </div>
              <Table className="hidden rounded-none border-0 w-full [&_table]:table-fixed md:block">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[34%] md:w-[26%] lg:w-[21%] xl:w-[18%] 2xl:w-[15%]">
                      {t("DashboardPayments.status")}
                    </TableHead>
                    <TableHead className="w-[26%] md:w-[22%] lg:w-[20%] xl:w-[18%] 2xl:w-[15%]">
                      {t("DashboardPayments.recurring.amount")}
                    </TableHead>
                    <TableHead className="w-[40%] md:w-[34%] lg:w-[31%] xl:w-[24%] 2xl:w-[20%]">
                      {t("DashboardPayments.counterpartyLabel")}
                    </TableHead>
                    <TableHead className="hidden lg:table-cell lg:w-[28%] xl:w-[22%] 2xl:w-[18%]">
                      {t("DashboardPayments.recurring.fundingWallet")}
                    </TableHead>
                    <TableHead className="hidden xl:table-cell xl:w-[18%] 2xl:w-[16%]">
                      {t("DashboardPayments.recurring.interval")}
                    </TableHead>
                    <TableHead
                      className={`${RECURRING_NEXT_PAYMENT_COLUMN_VISIBILITY} md:w-[18%] 2xl:w-[16%]`}
                    >
                      {t("DashboardPayments.recurring.nextPayment")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleRecurringPayments.map((recurringPayment) => {
                    const resolvedToken = getResolvedToken(recurringPayment);
                    const wallet = walletById.get(recurringPayment.sourceWalletId);
                    return (
                      <TableRow
                        key={recurringPayment.id}
                        role="button"
                        tabIndex={0}
                        onClick={() =>
                          router.push(
                            `/dashboard/payments/recurring/${encodeURIComponent(recurringPayment.id)}`
                          )
                        }
                        onKeyDown={(event: KeyboardEvent) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            router.push(
                              `/dashboard/payments/recurring/${encodeURIComponent(recurringPayment.id)}`
                            );
                          }
                        }}
                        className="cursor-pointer"
                      >
                        <TableCell>
                          <RecurringPaymentStatusBadge status={recurringPayment.status} />
                        </TableCell>
                        <TableCell className="font-medium">
                          <span className="flex min-w-0 items-center gap-2">
                            <TokenMark
                              mint={recurringPayment.token}
                              symbol={resolvedToken.tokenName}
                              logoUrl={resolvedToken.metadataImageUrl}
                              size="xs"
                            />
                            <span className="truncate">{getAmountLabel(recurringPayment)}</span>
                          </span>
                        </TableCell>
                        <TableCell className="text-sm text-secondary">
                          {counterpartyById.has(recurringPayment.counterpartyId) ? (
                            <EntityLink
                              href={`/dashboard/payments/counterparty/${encodeURIComponent(recurringPayment.counterpartyId)}`}
                              onClick={(event) => event.stopPropagation()}
                            >
                              {getCounterpartyLabel(recurringPayment)}
                            </EntityLink>
                          ) : (
                            <span className="block truncate">
                              {getCounterpartyLabel(recurringPayment)}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="hidden text-sm text-secondary lg:table-cell">
                          {wallet ? (
                            <EntityLink
                              href={`/dashboard/wallets/${encodeURIComponent(wallet.walletId)}`}
                              onClick={(event) => event.stopPropagation()}
                            >
                              {getWalletLabel(recurringPayment)}
                            </EntityLink>
                          ) : (
                            <span className="block truncate">
                              {getWalletLabel(recurringPayment)}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="hidden text-sm text-secondary xl:table-cell">
                          {formatPeriodHours(recurringPayment.periodHours, t)}
                        </TableCell>
                        <TableCell
                          className={`${RECURRING_NEXT_PAYMENT_COLUMN_VISIBILITY} text-sm text-secondary`}
                        >
                          {formatOptionalTimestamp(recurringPayment.nextCollectionDueAt, t)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            <PaginatedFooter
              className="mt-auto"
              page={listState.page}
              pageCount={pageCount}
              onPageChange={(nextPage) => applyListParams({ page: nextPage })}
              disabled={isPending}
              summary={t("DashboardPayments.recurring.range", {
                from: rangeStart,
                to: rangeEnd,
                total,
              })}
              pageSizeControl={{
                pageSize: listState.pageSize,
                onPageSizeChange: (nextPageSize) => applyListParams({ pageSize: nextPageSize }),
              }}
            />
          </>
        )}
      </DashboardWorkspaceCard>
    </DashboardWorkspaceOverviewPanel>
  );
}
