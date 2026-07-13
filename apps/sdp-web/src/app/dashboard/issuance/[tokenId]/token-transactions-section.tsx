"use client";

import type { TokenTransaction } from "@sdp/types";
import { Loader2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useLocale, useTranslations } from "@/i18n/provider";
import { formatDisplayLabel } from "@/lib/utils";
import { formatDate } from "./token-management-workspace.utils";

interface TokenTransactionsSectionProps {
  transactions: TokenTransaction[];
  transactionsError: string | null;
  transactionsTotal: number | null;
  transactionsHasMore: boolean;
  isLoading?: boolean;
}

// Transaction status → SDP design-system badge token (borderless tinted pill):
// settled = .badge-green, in-flight = .badge-amber, failed = .badge-red.
function transactionStatusBadgeClass(status: string): string {
  switch (status) {
    case "confirmed":
    case "finalized":
      return "bg-[rgba(0,160,102,0.08)] text-[#00a066]";
    case "pending":
    case "processing":
      return "bg-[rgba(234,179,8,0.08)] text-[#92400e]";
    case "failed":
      return "bg-[rgba(220,38,38,0.08)] text-[#dc2626]";
    default:
      return "bg-[rgba(28,28,29,0.08)] text-[rgba(28,28,29,0.72)]";
  }
}

export function TokenTransactionsSection({
  transactions,
  transactionsError,
  transactionsTotal,
  transactionsHasMore,
  isLoading = false,
}: TokenTransactionsSectionProps) {
  const t = useTranslations();
  const locale = useLocale();
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>{t("DashboardIssuance.transactions.title")}</CardTitle>
        <CardDescription>{t("DashboardIssuance.transactions.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex min-h-[180px] items-center justify-center rounded-2xl border border-[rgba(28,28,29,0.08)] bg-[rgba(28,28,29,0.02)] px-6 py-10">
            <div className="flex items-center gap-3 text-sm text-[rgba(28,28,29,0.64)]">
              <Loader2 className="size-4 animate-spin" />
              <span>{t("DashboardIssuance.transactions.loading")}</span>
            </div>
          </div>
        ) : transactionsError ? (
          <p className="text-sm text-[#dc2626]">{transactionsError}</p>
        ) : transactions.length === 0 ? (
          <p className="text-sm text-[rgba(28,28,29,0.68)]">
            {t("DashboardIssuance.transactions.empty")}
          </p>
        ) : (
          <div className="space-y-3">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("DashboardIssuance.transactions.type")}</TableHead>
                  <TableHead>{t("DashboardIssuance.transactions.status")}</TableHead>
                  <TableHead>{t("DashboardIssuance.transactions.signature")}</TableHead>
                  <TableHead>{t("DashboardIssuance.transactions.created")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {transactions.slice(0, 12).map((transaction) => (
                  <TableRow key={transaction.id} data-testid={`transaction-row-${transaction.id}`}>
                    <TableCell>{formatDisplayLabel(transaction.type)}</TableCell>
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
                    <TableCell>{formatDate(transaction.createdAt, locale)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {transactionsHasMore ? (
              <p className="text-xs text-[rgba(28,28,29,0.62)]">
                {t("DashboardIssuance.transactions.showing", {
                  count: transactions.length,
                  total: transactionsTotal ? ` of ${transactionsTotal}` : "",
                })}
              </p>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
