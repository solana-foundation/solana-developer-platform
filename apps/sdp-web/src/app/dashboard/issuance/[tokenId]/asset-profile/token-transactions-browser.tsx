"use client";

import {
  TOKEN_TRANSACTION_STATUSES,
  TOKEN_TRANSACTION_TYPES,
  type TokenTransaction,
} from "@sdp/types";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { ArrowPagination } from "@/components/ui/arrow-pagination";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Select, SelectItem } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useLocale, useTranslations } from "@/i18n/provider";
import { usePersistedDashboardSWR } from "@/lib/dashboard-swr";
import { formatDisplayLabel } from "@/lib/utils";
import { getPageCount, getPageSummary } from "../../pagination.utils";
import { formatDateTime } from "../token-management-workspace.utils";
import { transactionStatusBadgeClass } from "../token-transactions-section";
import { auditActionIcon, auditActionLabel } from "./asset-audit-presentation";
import { fetchTokenTransactionsPage } from "./transactions.data";
import { TOKEN_TRANSACTIONS_KEY } from "./transactions-cache";

const PAGE_SIZE = 50;
// Sentinel select value for the "no filter" option (Select treats null/"" as the
// empty placeholder, so the reset option needs a real value).
const ALL = "__all__";

function TransactionFilters({
  t,
  type,
  status,
  busy,
  onTypeChange,
  onStatusChange,
}: {
  t: ReturnType<typeof useTranslations>;
  type: string | null;
  status: string | null;
  // While a fetch is in flight, the selects are blocked (like the button) and
  // show a spinner so filter changes can't stack mid-request.
  busy: boolean;
  onTypeChange: (value: string | null) => void;
  onStatusChange: (value: string | null) => void;
}) {
  const spinner = busy ? <Loader2 className="size-3.5 animate-spin" /> : null;
  return (
    <CardAction className="flex flex-wrap items-center justify-end gap-2">
      <div className="w-44">
        <Select
          ariaLabel={t("DashboardIssuance.transactions.filterByType")}
          value={type ?? ALL}
          disabled={busy}
          trailing={spinner}
          onValueChange={(value) => onTypeChange(value === ALL ? null : value)}
        >
          <SelectItem value={ALL}>{t("DashboardIssuance.transactions.filterAllTypes")}</SelectItem>
          {TOKEN_TRANSACTION_TYPES.map((value) => (
            <SelectItem key={value} value={value}>
              {auditActionLabel(value)}
            </SelectItem>
          ))}
        </Select>
      </div>
      <div className="w-44">
        <Select
          ariaLabel={t("DashboardIssuance.transactions.filterByStatus")}
          value={status ?? ALL}
          disabled={busy}
          trailing={spinner}
          onValueChange={(value) => onStatusChange(value === ALL ? null : value)}
        >
          <SelectItem value={ALL}>
            {t("DashboardIssuance.transactions.filterAllStatuses")}
          </SelectItem>
          {TOKEN_TRANSACTION_STATUSES.map((value) => (
            <SelectItem key={value} value={value}>
              {formatDisplayLabel(value)}
            </SelectItem>
          ))}
        </Select>
      </div>
    </CardAction>
  );
}

function TransactionRow({
  transaction,
  locale,
}: {
  transaction: TokenTransaction;
  locale: ReturnType<typeof useLocale>;
}) {
  const ActionIcon = auditActionIcon(transaction.type);
  return (
    <TableRow data-testid={`transaction-row-${transaction.id}`}>
      <TableCell>
        <span className="inline-flex items-center gap-1.5 rounded-md bg-fill-subtle px-2 py-1 text-xs font-medium text-secondary">
          <ActionIcon className="h-3.5 w-3.5 shrink-0" />
          {auditActionLabel(transaction.type)}
        </span>
      </TableCell>
      <TableCell>
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${transactionStatusBadgeClass(
            transaction.status
          )}`}
        >
          {formatDisplayLabel(transaction.status)}
        </span>
      </TableCell>
      <TableCell className="max-w-[220px] truncate font-mono text-xs">
        {transaction.signature ?? "—"}
      </TableCell>
      <TableCell className="text-right whitespace-nowrap">
        {formatDateTime(transaction.createdAt, locale)}
      </TableCell>
    </TableRow>
  );
}

function TransactionsResults({
  t,
  locale,
  isInitialLoading,
  isRefreshing,
  busy,
  errorMessage,
  transactions,
  total,
  page,
  onPageChange,
  hasFilters,
}: {
  t: ReturnType<typeof useTranslations>;
  locale: ReturnType<typeof useLocale>;
  isInitialLoading: boolean;
  isRefreshing: boolean;
  busy: boolean;
  errorMessage: string | null;
  transactions: TokenTransaction[];
  total: number;
  page: number;
  onPageChange: (page: number) => void;
  hasFilters: boolean;
}) {
  if (isInitialLoading) {
    return (
      <div className="flex min-h-[180px] items-center justify-center rounded-2xl border border-border-subtle bg-fill-subtle px-6 py-10">
        <div className="flex items-center gap-3 text-sm text-secondary">
          <Loader2 className="size-4 animate-spin" />
          <span>{t("DashboardIssuance.transactions.loading")}</span>
        </div>
      </div>
    );
  }
  if (errorMessage) {
    return <p className="text-sm text-error">{errorMessage}</p>;
  }
  if (transactions.length === 0) {
    return (
      <p className="text-sm text-secondary">
        {hasFilters
          ? t("DashboardIssuance.transactions.noMatches")
          : t("DashboardIssuance.transactions.empty")}
      </p>
    );
  }
  const { pageCount, start, end } = getPageSummary({
    page,
    pageSize: PAGE_SIZE,
    total,
    shown: transactions.length,
  });
  return (
    <div
      aria-busy={isRefreshing}
      className={`space-y-3 transition-opacity ${isRefreshing ? "opacity-60" : ""}`}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("DashboardIssuance.transactions.type")}</TableHead>
            <TableHead>{t("DashboardIssuance.transactions.status")}</TableHead>
            <TableHead>{t("DashboardIssuance.transactions.signature")}</TableHead>
            <TableHead className="text-right">
              {t("DashboardIssuance.transactions.created")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {transactions.map((transaction) => (
            <TransactionRow key={transaction.id} transaction={transaction} locale={locale} />
          ))}
        </TableBody>
      </Table>
      <ArrowPagination
        page={page}
        pageCount={pageCount}
        onPageChange={onPageChange}
        disabled={busy}
        summary={t("DashboardIssuance.pagination.range", { start, end, total })}
      />
    </div>
  );
}

export function TokenTransactionsBrowser({ tokenId }: { tokenId: string }) {
  const t = useTranslations();
  const locale = useLocale();
  const [type, setType] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const { data, error, isLoading, isValidating } = usePersistedDashboardSWR(
    [TOKEN_TRANSACTIONS_KEY, tokenId, type ?? "all", status ?? "all", page] as const,
    ([, id, ty, st, pageNumber]) =>
      fetchTokenTransactionsPage(id, {
        type: ty === "all" ? null : ty,
        status: st === "all" ? null : st,
        page: Number(pageNumber),
        pageSize: PAGE_SIZE,
      }),
    // keepPreviousData → paging/filtering keeps the current rows on screen
    // (dimmed) while the next page loads, instead of flashing the empty state.
    { revalidateOnFocus: true, revalidateIfStale: true, keepPreviousData: true },
    {
      key: `token.${tokenId}.transactions.${type ?? "all"}.${status ?? "all"}.${page}`,
      ttlMs: 30_000,
    }
  );

  const transactions = data?.transactions ?? [];
  const total = data?.total ?? 0;
  const hasFilters = type !== null || status !== null;
  // `busy` = any in-flight fetch. With keepPreviousData, isLoading is only true on
  // the very first load (no data yet), so isValidating is what catches filter
  // changes and "Load more". The filters + button are blocked while busy; a
  // refetch over already-shown rows also dims them.
  const busy = isValidating;
  const isInitialLoading = isLoading && transactions.length === 0;
  const isRefreshing = busy && transactions.length > 0;
  // A shrinking result set (new filter, rows aged out) can leave the current
  // page past the end; step back to the last real page instead of showing an
  // empty list under a "Page 5 of 3" pager.
  const pageCount = getPageCount(total, PAGE_SIZE);
  useEffect(() => {
    if (page > pageCount) {
      setPage(pageCount);
    }
  }, [page, pageCount]);
  const errorMessage = error
    ? error instanceof Error
      ? error.message
      : t("DashboardIssuance.transactions.loadError")
    : null;

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>{t("DashboardIssuance.transactions.title")}</CardTitle>
        <CardDescription>{t("DashboardIssuance.transactions.description")}</CardDescription>
        <TransactionFilters
          t={t}
          type={type}
          status={status}
          busy={busy}
          onTypeChange={(value) => {
            setType(value);
            setPage(1);
          }}
          onStatusChange={(value) => {
            setStatus(value);
            setPage(1);
          }}
        />
      </CardHeader>
      <CardContent>
        <TransactionsResults
          t={t}
          locale={locale}
          isInitialLoading={isInitialLoading}
          isRefreshing={isRefreshing}
          busy={busy}
          errorMessage={errorMessage}
          transactions={transactions}
          total={total}
          page={page}
          onPageChange={setPage}
          hasFilters={hasFilters}
        />
      </CardContent>
    </Card>
  );
}
