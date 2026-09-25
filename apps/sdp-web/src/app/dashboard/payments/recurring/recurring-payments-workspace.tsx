"use client";

import {
  PAYMENT_RECURRING_PAYMENT_STATUSES,
  type PaymentRecurringPayment,
  type PaymentRecurringPaymentStatus,
} from "@sdp/types";
import { PlusIcon, RepeatIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { z } from "zod";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { ArrowPagination } from "@/components/ui/arrow-pagination";
import { Button } from "@/components/ui/button";
import { FilterMenu, FilterMenuOptions } from "@/components/ui/filter-menu";
import { ListEmptyState } from "@/components/ui/list-empty-state";
import { ListToolbar, RowsPerPageSelect } from "@/components/ui/list-toolbar";
import { SearchInput } from "@/components/ui/search-input";
import { StatusText, type StatusTone } from "@/components/ui/status-text";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useLocale, useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import {
  formatDisplayAmount,
  resolveTokenByMint,
  shortenAddress,
} from "../payments-overview.utils";
import type { PaymentsIssuedTokenSymbol } from "../payments-page.data";
import { formatDateTime } from "../payments-presentation";
import {
  RECURRING_LIST_DEFAULT_PAGE_SIZE,
  RECURRING_PAYMENT_STATUSES,
  type RecurringPaymentsListState,
} from "./recurring-payments.data";
import {
  formatPeriodHours,
  type RecurringPaymentCounterpartyView,
  type RecurringPaymentWalletView,
  resolveTokenLabel,
  STATUS_TRANSLATION_KEYS,
} from "./recurring-payments-shared";

/** How each schedule status reads in the list: settled, still moving, waiting, or lapsed. */
const STATUS_TONES = {
  pending_activation: "attention",
  activating: "progress",
  active: "positive",
  updating: "progress",
  canceling: "progress",
  resuming: "progress",
  paused: "attention",
  canceled: "neutral",
  expired: "neutral",
} as const satisfies Record<PaymentRecurringPaymentStatus, StatusTone>;

const CREATE_HREF = "/dashboard/payments/recurring/create";

function scheduleHref(recurringPaymentId: string): string {
  return `/dashboard/payments/recurring/${encodeURIComponent(recurringPaymentId)}`;
}

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

/**
 * The Schedules list. The status filter and the page live in the URL and load on the server;
 * search runs here over the loaded page, because the API has none.
 */
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
  const locale = useLocale();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [isPending, startTransition] = useTransition();

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
    () => new Map(wallets.map((wallet) => [wallet.id, wallet])),
    [wallets]
  );
  const counterpartyById = useMemo(
    () => new Map(counterparties.map((counterparty) => [counterparty.id, counterparty])),
    [counterparties]
  );

  const getWalletLabel = (recurringPayment: PaymentRecurringPayment) => {
    const wallet = recurringPayment.sourceCustodyWalletId
      ? walletById.get(recurringPayment.sourceCustodyWalletId)
      : undefined;
    return wallet === undefined
      ? recurringPayment.sourceProviderWalletId
      : wallet.label === null
        ? shortenAddress(wallet.publicKey)
        : wallet.label;
  };
  const getCounterpartyLabel = (recurringPayment: PaymentRecurringPayment) => {
    const counterparty = counterpartyById.get(recurringPayment.counterpartyId);
    return counterparty === undefined
      ? t("DashboardPayments.recurring.counterpartyUnavailable")
      : counterparty.displayName;
  };
  const getAmountLabel = (recurringPayment: PaymentRecurringPayment) =>
    formatDisplayAmount(
      recurringPayment.amount,
      resolveTokenByMint(
        recurringPayment.token,
        issuedTokensByMint,
        resolveTokenLabel(recurringPayment.token, wallets)
      ).tokenName
    );
  const getScheduleTitle = (recurringPayment: PaymentRecurringPayment) =>
    t("DashboardPayments.recurring.amountToCounterparty", {
      amount: getAmountLabel(recurringPayment),
      counterparty: getCounterpartyLabel(recurringPayment),
    });
  const statusLabel = (status: PaymentRecurringPaymentStatus) => t(STATUS_TRANSLATION_KEYS[status]);

  const needle = query.trim().toLowerCase();
  const visibleRecurringPayments = initialRecurringPayments.filter((recurringPayment) => {
    if (!needle) {
      return true;
    }
    return [
      getCounterpartyLabel(recurringPayment),
      getWalletLabel(recurringPayment),
      getAmountLabel(recurringPayment),
    ]
      .join(" ")
      .toLowerCase()
      .includes(needle);
  });

  const pageCount = Math.max(1, Math.ceil(total / listState.pageSize));
  const rangeStart = total === 0 ? 0 : (listState.page - 1) * listState.pageSize + 1;
  const rangeEnd = Math.min(listState.page * listState.pageSize, total);
  const listIsEmpty = total === 0 && listState.status === null;

  if (initialError) {
    return (
      <DashboardWorkspaceOverviewPanel>
        <div
          role="alert"
          className="rounded-card border border-error-border bg-error-bg p-4 text-body text-error"
        >
          <p className="font-medium">{t("DashboardPayments.recurring.unableToLoad")}</p>
          <p className="mt-1">{initialError}</p>
        </div>
      </DashboardWorkspaceOverviewPanel>
    );
  }

  if (listIsEmpty) {
    return (
      <DashboardWorkspaceOverviewPanel className="flex flex-col">
        <ListEmptyState
          icon={<RepeatIcon className="size-5" aria-hidden="true" />}
          message={t("DashboardPayments.recurring.noPayments")}
          description={t("DashboardPayments.recurring.paymentsAppearHere")}
          action={
            <Button asChild size="sm">
              <Link href={CREATE_HREF}>
                <PlusIcon className="size-4" aria-hidden="true" />
                {t("DashboardPayments.recurring.newSchedule")}
              </Link>
            </Button>
          }
        />
      </DashboardWorkspaceOverviewPanel>
    );
  }

  return (
    <DashboardWorkspaceOverviewPanel className="flex flex-col gap-5">
      <ListToolbar
        filters={
          <FilterMenu
            label={t("Shared.SharedComponents.filter")}
            searchPlaceholder={t("Shared.SharedComponents.filterBy")}
            sections={[
              {
                id: "status",
                label: t("DashboardPayments.status"),
                value: listState.status === null ? undefined : statusLabel(listState.status),
                content: (
                  <FilterMenuOptions
                    value={listState.status ?? undefined}
                    anyLabel={t("DashboardPayments.recurring.allStatuses")}
                    options={RECURRING_PAYMENT_STATUSES.map((status) => ({
                      value: status,
                      label: statusLabel(status),
                    }))}
                    onChange={(value) => {
                      const parsed = z.enum(PAYMENT_RECURRING_PAYMENT_STATUSES).safeParse(value);
                      applyListParams({ status: parsed.success ? parsed.data : null });
                    }}
                  />
                ),
              },
            ]}
          />
        }
      >
        <RowsPerPageSelect
          value={listState.pageSize}
          onChange={(pageSize) => applyListParams({ pageSize })}
        />
        <SearchInput
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          clear={{
            label: t("DashboardPayments.recurring.clearSearch"),
            onClear: () => setQuery(""),
          }}
          placeholder={t("DashboardPayments.recurring.searchPayments")}
          className="min-w-0 flex-1 sm:w-56 sm:flex-none"
        />
      </ListToolbar>
      {lookupError ? <p className="text-meta text-warning">{lookupError}</p> : null}
      {visibleRecurringPayments.length === 0 ? (
        <p className="py-12 text-center text-body text-tertiary">
          {t("DashboardPayments.recurring.noMatches")}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <Table className="min-w-[760px] rounded-none border-0" data-recurring-payments-table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("DashboardPayments.status")}</TableHead>
                <TableHead>{t("DashboardPayments.recurring.schedule")}</TableHead>
                <TableHead>{t("DashboardPayments.recurring.repeats")}</TableHead>
                <TableHead>{t("DashboardPayments.recurring.nextRun")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleRecurringPayments.map((recurringPayment) => {
                const href = scheduleHref(recurringPayment.id);
                return (
                  <TableRow
                    key={recurringPayment.id}
                    className="cursor-pointer"
                    onClick={() => router.push(href)}
                  >
                    <TableCell className="text-body whitespace-nowrap">
                      <StatusText tone={STATUS_TONES[recurringPayment.status]}>
                        {statusLabel(recurringPayment.status)}
                      </StatusText>
                    </TableCell>
                    <TableCell className="max-w-96">
                      <Link
                        href={href}
                        className="block truncate text-body text-primary focus-visible:underline focus-visible:outline-none"
                        onClick={(event) => event.stopPropagation()}
                      >
                        {getScheduleTitle(recurringPayment)}
                      </Link>
                      <span className="block truncate text-meta text-secondary">
                        {t("DashboardPayments.recurring.fromWallet", {
                          wallet: getWalletLabel(recurringPayment),
                        })}
                      </span>
                    </TableCell>
                    <TableCell className="text-body whitespace-nowrap text-secondary">
                      {formatPeriodHours(recurringPayment.periodHours, t)}
                    </TableCell>
                    <TableCell
                      className={cn(
                        "text-body whitespace-nowrap",
                        recurringPayment.nextCollectionDueAt ? "text-primary" : "text-tertiary"
                      )}
                    >
                      {recurringPayment.nextCollectionDueAt
                        ? formatDateTime(recurringPayment.nextCollectionDueAt, locale)
                        : t("DashboardPayments.recurring.notScheduled")}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      <ArrowPagination
        page={listState.page}
        pageCount={pageCount}
        onPageChange={(page) => applyListParams({ page })}
        disabled={isPending}
        summary={t("DashboardPayments.recurring.range", {
          from: rangeStart,
          to: rangeEnd,
          total,
        })}
      />
    </DashboardWorkspaceOverviewPanel>
  );
}
