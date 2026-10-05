"use client";

import {
  PAYMENT_RECURRING_PAYMENT_STATUSES,
  type PaymentRecurringPayment,
  type PaymentRecurringPaymentStatus,
} from "@sdp/types";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { z } from "zod";
import { DashboardWorkspaceOverviewPanel } from "@/components/dashboard-workspace-panel";
import { ArrowPagination } from "@/components/ui/arrow-pagination";
import { Button } from "@/components/ui/button";
import { FilterMenu, FilterMenuOptions } from "@/components/ui/filter-menu";
import { ListEmptyState } from "@/components/ui/list-empty-state";
import { ListToolbar } from "@/components/ui/list-toolbar";
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
import { formatDate } from "../payments-presentation";
import { PAYMENTS_TABLE_CELL, PAYMENTS_TABLE_HEAD } from "../payments-table";
import {
  RECURRING_LIST_DEFAULT_PAGE_SIZE,
  RECURRING_PAYMENT_STATUSES,
  type RecurringPaymentsListState,
} from "./recurring-payments.data.redesign";
import {
  formatPeriodHours,
  type RecurringPaymentCounterpartyView,
  type RecurringPaymentWalletView,
  resolveTokenLabel,
  STATUS_TRANSLATION_KEYS,
} from "./recurring-payments-shared.redesign";

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

/**
 * The pager under the list, with which schedules of how many it shows. One page needs no pager,
 * as the design's lists show none. A saved link can still name a page past the end, once
 * schedules are gone; that page keeps the pager, its back arrow landing on the last page.
 */
function RecurringPaymentsPagination({
  page,
  pageSize,
  total,
  pending,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  pending: boolean;
  onPageChange: (page: number) => void;
}) {
  const t = useTranslations();
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (page === 1 && pageCount === 1) return null;
  const rangeStart = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = Math.min(page * pageSize, total);
  return (
    <ArrowPagination
      page={page}
      pageCount={pageCount}
      onPageChange={(next) => onPageChange(Math.min(next, pageCount))}
      disabled={pending}
      // Past the end there are no rows to count: the pager names the page of how many.
      summary={
        page > pageCount
          ? undefined
          : t("DashboardPayments.newDesign.recurring.range", {
              from: rangeStart,
              to: rangeEnd,
              total,
            })
      }
    />
  );
}

type ListParamUpdates = {
  page?: number;
  pageSize?: number;
  status?: PaymentRecurringPaymentStatus | null;
};

/**
 * Writes the list's page, page size and status filter to the URL, which the server reads to
 * load the page; a new page size or filter goes back to the first page.
 */
function useRecurringListParams() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const applyListParams = (updates: ListParamUpdates) => {
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

  return { applyListParams, isPending };
}

/** A schedule's labels: its source wallet, its counterparty by name, its amount by token. */
function useRecurringPaymentLabels({
  issuedTokensByMint,
  wallets,
  counterparties,
}: {
  issuedTokensByMint: Record<string, PaymentsIssuedTokenSymbol>;
  wallets: RecurringPaymentWalletView[];
  counterparties: RecurringPaymentCounterpartyView[];
}) {
  const t = useTranslations();
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

  return { getWalletLabel, getCounterpartyLabel, getAmountLabel, getScheduleTitle };
}

type RecurringPaymentLabels = ReturnType<typeof useRecurringPaymentLabels>;

/** The list could not be read: the panel says so, with the API's reason. */
function RecurringPaymentsLoadError({ error }: { error: string }) {
  const t = useTranslations();
  return (
    <DashboardWorkspaceOverviewPanel>
      <div
        role="alert"
        className="rounded-card border border-error-border bg-error-bg p-4 text-body text-error"
      >
        <p className="font-medium">{t("DashboardPayments.newDesign.recurring.unableToLoad")}</p>
        <p className="mt-1">{error}</p>
      </div>
    </DashboardWorkspaceOverviewPanel>
  );
}

/** No schedules yet, with no filter on: the empty state offers the first one. */
function RecurringPaymentsEmpty() {
  const t = useTranslations();
  return (
    <DashboardWorkspaceOverviewPanel className="flex flex-col">
      <ListEmptyState
        hidesPageAction
        message={t("DashboardPayments.recurring.emptyTitle")}
        description={t("DashboardPayments.recurring.emptyDescription")}
        action={
          <Button asChild size="sm">
            <Link href={CREATE_HREF}>{t("DashboardPayments.recurring.newSchedule")}</Link>
          </Button>
        }
      />
    </DashboardWorkspaceOverviewPanel>
  );
}

/** The status filter, which reloads the list, and the search over the loaded page. */
function RecurringPaymentsToolbar({
  status,
  query,
  onStatusChange,
  onQueryChange,
}: {
  status: PaymentRecurringPaymentStatus | null;
  query: string;
  onStatusChange: (status: PaymentRecurringPaymentStatus | null) => void;
  onQueryChange: (query: string) => void;
}) {
  const t = useTranslations();
  const statusLabel = (value: PaymentRecurringPaymentStatus) => t(STATUS_TRANSLATION_KEYS[value]);
  return (
    // The design draws the search at the Filter button's 30px, its rule level with the button's
    // bottom edge; the shared field defaults to the taller input.
    <ListToolbar
      className="[--input-height-lg:1.875rem]"
      filters={
        <FilterMenu
          label={t("Shared.SharedComponents.filter")}
          searchPlaceholder={t("Shared.SharedComponents.filterBy")}
          sections={[
            {
              id: "status",
              label: t("DashboardPayments.status"),
              value: status === null ? undefined : statusLabel(status),
              content: (
                <FilterMenuOptions
                  value={status ?? undefined}
                  anyLabel={t("DashboardPayments.recurring.allStatuses")}
                  options={RECURRING_PAYMENT_STATUSES.map((option) => ({
                    value: option,
                    label: statusLabel(option),
                  }))}
                  onChange={(value) => {
                    const parsed = z.enum(PAYMENT_RECURRING_PAYMENT_STATUSES).safeParse(value);
                    onStatusChange(parsed.success ? parsed.data : null);
                  }}
                />
              ),
            },
          ]}
        />
      }
    >
      <SearchInput
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        clear={{
          label: t("DashboardPayments.recurring.clearSearch"),
          onClear: () => onQueryChange(""),
        }}
        placeholder={t("DashboardPayments.newDesign.recurring.searchPayments")}
        className="min-w-0 flex-1 sm:w-56 sm:flex-none"
      />
    </ListToolbar>
  );
}

/**
 * One schedule as the design's two-line row: 10px above and below, every cell on the name's
 * line. The whole row opens the schedule; its name is the link a keyboard reaches.
 */
function RecurringPaymentRow({
  recurringPayment,
  labels,
}: {
  recurringPayment: PaymentRecurringPayment;
  labels: RecurringPaymentLabels;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const href = scheduleHref(recurringPayment.id);
  return (
    <TableRow
      className="cursor-pointer [--table-cell-padding-y:10px] [&>td]:align-top"
      onClick={() => router.push(href)}
    >
      <TableCell className={cn(PAYMENTS_TABLE_CELL, "whitespace-nowrap")}>
        <StatusText tone={STATUS_TONES[recurringPayment.status]} className={PAYMENTS_TABLE_CELL}>
          {t(STATUS_TRANSLATION_KEYS[recurringPayment.status])}
        </StatusText>
      </TableCell>
      <TableCell className={PAYMENTS_TABLE_CELL}>
        <Link
          href={href}
          className="block truncate text-body leading-5 font-medium text-primary focus-visible:underline focus-visible:outline-none"
          onClick={(event) => event.stopPropagation()}
        >
          {labels.getScheduleTitle(recurringPayment)}
        </Link>
        <span className="block truncate text-secondary">
          {t("DashboardPayments.recurring.fromWallet", {
            wallet: labels.getWalletLabel(recurringPayment),
          })}
        </span>
      </TableCell>
      <TableCell className={cn(PAYMENTS_TABLE_CELL, "whitespace-nowrap text-secondary")}>
        {formatPeriodHours(recurringPayment.periodHours, t)}
      </TableCell>
      <TableCell
        className={cn(
          PAYMENTS_TABLE_CELL,
          "whitespace-nowrap tabular-nums",
          recurringPayment.nextCollectionDueAt ? "text-primary" : "text-tertiary"
        )}
      >
        {recurringPayment.nextCollectionDueAt
          ? formatDate(recurringPayment.nextCollectionDueAt, locale)
          : t("DashboardPayments.recurring.notScheduled")}
      </TableCell>
      {/* A schedule has no stop date yet: it runs until it is paused or canceled. */}
      <TableCell className={cn(PAYMENTS_TABLE_CELL, "whitespace-nowrap text-tertiary")}>
        {t("DashboardPayments.recurring.noEndDate")}
      </TableCell>
    </TableRow>
  );
}

/**
 * The design's list: 26px under the toolbar, flush with the column (no overhang, the edge cells
 * unpadded), a header over a stronger rule, and the columns as measured on its 852px list; fixed,
 * so a long schedule truncates instead of squeezing the dates.
 */
function RecurringPaymentsTable({
  recurringPayments,
  labels,
}: {
  recurringPayments: PaymentRecurringPayment[];
  labels: RecurringPaymentLabels;
}) {
  const t = useTranslations();
  return (
    <div className="mt-1.5 overflow-x-auto">
      <Table
        className="min-w-[760px] table-fixed rounded-none border-0 [&_td:first-child]:ps-0 [&_td:last-child]:pe-0 [&_th:first-child]:ps-0 [&_th:last-child]:pe-0"
        data-recurring-payments-table
      >
        <TableHeader>
          <TableRow className="[&>th]:border-border-default">
            <TableHead className={cn(PAYMENTS_TABLE_HEAD, "w-[15.2%]")}>
              {t("DashboardPayments.status")}
            </TableHead>
            <TableHead className={cn(PAYMENTS_TABLE_HEAD, "w-[35%]")}>
              {t("DashboardPayments.recurring.schedule")}
            </TableHead>
            <TableHead className={cn(PAYMENTS_TABLE_HEAD, "w-[18%]")}>
              {t("DashboardPayments.recurring.repeats")}
            </TableHead>
            <TableHead className={cn(PAYMENTS_TABLE_HEAD, "w-[15%]")}>
              {t("DashboardPayments.recurring.nextRun")}
            </TableHead>
            <TableHead className={cn(PAYMENTS_TABLE_HEAD, "w-[16.8%]")}>
              {t("DashboardPayments.recurring.ends")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {recurringPayments.map((recurringPayment) => (
            <RecurringPaymentRow
              key={recurringPayment.id}
              recurringPayment={recurringPayment}
              labels={labels}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
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
  const [query, setQuery] = useState("");
  const { applyListParams, isPending } = useRecurringListParams();
  const labels = useRecurringPaymentLabels({ issuedTokensByMint, wallets, counterparties });

  const needle = query.trim().toLowerCase();
  const visibleRecurringPayments = initialRecurringPayments.filter((recurringPayment) => {
    if (!needle) {
      return true;
    }
    return [
      labels.getCounterpartyLabel(recurringPayment),
      labels.getWalletLabel(recurringPayment),
      labels.getAmountLabel(recurringPayment),
    ]
      .join(" ")
      .toLowerCase()
      .includes(needle);
  });

  if (initialError) {
    return <RecurringPaymentsLoadError error={initialError} />;
  }

  if (total === 0 && listState.status === null) {
    return <RecurringPaymentsEmpty />;
  }

  return (
    <DashboardWorkspaceOverviewPanel className="flex flex-col gap-5">
      <RecurringPaymentsToolbar
        status={listState.status}
        query={query}
        onStatusChange={(status) => applyListParams({ status })}
        onQueryChange={setQuery}
      />
      {lookupError ? <p className="text-meta text-warning">{lookupError}</p> : null}
      {visibleRecurringPayments.length === 0 ? (
        <p className="py-12 text-center text-body text-tertiary">
          {t("DashboardPayments.newDesign.recurring.noMatches")}
        </p>
      ) : (
        <RecurringPaymentsTable recurringPayments={visibleRecurringPayments} labels={labels} />
      )}
      <RecurringPaymentsPagination
        page={listState.page}
        pageSize={listState.pageSize}
        total={total}
        pending={isPending}
        onPageChange={(page) => applyListParams({ page })}
      />
    </DashboardWorkspaceOverviewPanel>
  );
}
