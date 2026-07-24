"use client";

import {
  TOKEN_TRANSACTION_STATUSES,
  TOKEN_TRANSACTION_TYPES,
  type TokenTransaction,
} from "@sdp/types";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
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
import { formatDateTime } from "../token-management-workspace.utils";
import { transactionStatusBadgeClass } from "../token-transactions-section";
import { auditActionIcon, auditActionLabel } from "./asset-audit-presentation";
import { fetchTokenTransactionsPage } from "./transactions.data";
import { TOKEN_TRANSACTIONS_KEY } from "./transactions-cache";

const PAGE_STEP = 50;
// Sentinel select value for the "no filter" option (Select treats null/"" as the
// empty placeholder, so the reset option needs a real value).
const ALL = "__all__";

function TransactionFilters({
  t,
  type,
  status,
  onTypeChange,
  onStatusChange,
}: {
  t: ReturnType<typeof useTranslations>;
  type: string | null;
  status: string | null;
  onTypeChange: (value: string | null) => void;
  onStatusChange: (value: string | null) => void;
}) {
  return (
    <CardAction className="flex flex-wrap items-center justify-end gap-2">
      <div className="w-44">
        <Select
          ariaLabel={t("DashboardIssuance.transactions.filterByType")}
          value={type ?? ALL}
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

export function TokenTransactionsBrowser({ tokenId }: { tokenId: string }) {
  const t = useTranslations();
  const locale = useLocale();
  const [type, setType] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [pageSize, setPageSize] = useState(PAGE_STEP);

  const { data, error, isLoading } = usePersistedDashboardSWR(
    [TOKEN_TRANSACTIONS_KEY, tokenId, type ?? "all", status ?? "all", pageSize] as const,
    ([, id, ty, st, size]) =>
      fetchTokenTransactionsPage(id, {
        type: ty === "all" ? null : ty,
        status: st === "all" ? null : st,
        pageSize: Number(size),
      }),
    { revalidateOnFocus: true, revalidateIfStale: true },
    {
      key: `token.${tokenId}.transactions.${type ?? "all"}.${status ?? "all"}.${pageSize}`,
      ttlMs: 30_000,
    }
  );

  const transactions = data?.transactions ?? [];
  const total = data?.total ?? 0;
  const hasFilters = type !== null || status !== null;
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
          onTypeChange={(value) => {
            setType(value);
            setPageSize(PAGE_STEP);
          }}
          onStatusChange={(value) => {
            setStatus(value);
            setPageSize(PAGE_STEP);
          }}
        />
      </CardHeader>
      <CardContent>
        {isLoading && transactions.length === 0 ? (
          <div className="flex min-h-[180px] items-center justify-center rounded-2xl border border-border-subtle bg-fill-subtle px-6 py-10">
            <div className="flex items-center gap-3 text-sm text-secondary">
              <Loader2 className="size-4 animate-spin" />
              <span>{t("DashboardIssuance.transactions.loading")}</span>
            </div>
          </div>
        ) : errorMessage ? (
          <p className="text-sm text-error">{errorMessage}</p>
        ) : transactions.length === 0 ? (
          <p className="text-sm text-secondary">
            {hasFilters
              ? t("DashboardIssuance.transactions.noMatches")
              : t("DashboardIssuance.transactions.empty")}
          </p>
        ) : (
          <div className="space-y-3">
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
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-secondary">
                {t("DashboardIssuance.transactions.showing", {
                  count: transactions.length,
                  total: total ? ` of ${total}` : "",
                })}
              </p>
              {data?.hasMore ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isLoading}
                  onClick={() => setPageSize((size) => size + PAGE_STEP)}
                >
                  {t("DashboardIssuance.transactions.loadMore")}
                </Button>
              ) : null}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
