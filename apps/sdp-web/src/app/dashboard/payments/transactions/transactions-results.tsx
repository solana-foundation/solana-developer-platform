"use client";

import type { UnifiedTransaction } from "@sdp/types";
import { ReceiptTextIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import type { KeyboardEvent } from "react";
import { ArrowPagination } from "@/components/ui/arrow-pagination";
import { ListEmptyState } from "@/components/ui/list-empty-state";
import { StatusText } from "@/components/ui/status-text";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useLocale, useTranslations } from "@/i18n/provider";
import { transactionHref } from "@/lib/payments-routes";
import { resolveTokenByMint, shortenAddress } from "../payments-overview.utils";
import type { PaymentsIssuedTokenSymbol } from "../payments-page.data";
import { formatDateTime, formatDecimalAmount } from "../payments-presentation";
import { kindLabel, useTransactionStatus } from "./transaction-status";
import type { TransactionsPageResult } from "./transactions-page.data";
import { useTransactionFilters } from "./transactions-workspace";
import { useCursorPagination } from "./use-cursor-pagination";

export function TransactionsResults({
  result,
  issuedTokensByMint,
  counterpartyNames,
}: {
  result: TransactionsPageResult;
  issuedTokensByMint: Record<string, PaymentsIssuedTokenSymbol>;
  counterpartyNames: ReadonlyMap<string, string>;
}) {
  const locale = useLocale();
  const t = useTranslations();
  const statusOf = useTransactionStatus();
  const { filters, pending, navigate } = useTransactionFilters();
  const pagination = useCursorPagination(filters, result.nextCursor, navigate);
  const router = useRouter();
  const open = (transaction: UnifiedTransaction) => router.push(transactionHref(transaction.id));
  if (result.transactions.length === 0) {
    return (
      <ListEmptyState
        icon={<ReceiptTextIcon className="size-5" />}
        message={t("DashboardPayments.transactions.noTransactionsFound")}
      />
    );
  }
  return (
    <section className="flex min-w-0 flex-1 flex-col" aria-busy={pending}>
      <div className="overflow-x-auto refresh:-mx-3">
        <Table className="min-w-[760px] rounded-none border-0">
          <TableHeader>
            <TableRow>
              <TableHead>{t("DashboardPayments.transactions.status")}</TableHead>
              <TableHead>{t("DashboardPayments.transactions.type")}</TableHead>
              <TableHead className="text-right">
                {t("DashboardPayments.transactions.amount")}
              </TableHead>
              <TableHead>{t("DashboardPayments.transactions.contact")}</TableHead>
              <TableHead>{t("DashboardPayments.transactions.wallet")}</TableHead>
              <TableHead>{t("DashboardPayments.transactions.created")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.transactions.map((transaction) => {
              const status = statusOf(transaction);
              const token =
                transaction.token === null
                  ? null
                  : resolveTokenByMint(transaction.token, issuedTokensByMint).tokenName;
              const contact =
                transaction.counterpartyId === null
                  ? null
                  : (counterpartyNames.get(transaction.counterpartyId) ??
                    shortenAddress(transaction.counterpartyId));
              const wallet =
                transaction.custodyWalletId === null
                  ? null
                  : (transaction.custodyWalletLabel ?? shortenAddress(transaction.custodyWalletId));
              return (
                <TableRow
                  key={`${transaction.module}:${transaction.id}`}
                  role="link"
                  tabIndex={0}
                  onClick={() => open(transaction)}
                  onKeyDown={(event: KeyboardEvent) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      open(transaction);
                    }
                  }}
                  className="cursor-pointer"
                >
                  <TableCell>
                    <StatusText tone={status.tone} className="text-body">
                      {status.label}
                    </StatusText>
                  </TableCell>
                  <TableCell className="text-body text-secondary">
                    {kindLabel(t, transaction)}
                  </TableCell>
                  <TableCell className="text-right text-body whitespace-nowrap tabular-nums">
                    {transaction.amount === null ? (
                      <span className="text-tertiary">—</span>
                    ) : (
                      <>
                        <span className="text-primary">
                          {formatDecimalAmount(transaction.amount, locale)}
                        </span>
                        {token === null ? null : <span className="text-secondary"> {token}</span>}
                      </>
                    )}
                  </TableCell>
                  <TableCell
                    className="max-w-48 truncate text-body text-primary"
                    title={contact ?? undefined}
                  >
                    {contact ?? <span className="text-tertiary">—</span>}
                  </TableCell>
                  <TableCell
                    className="max-w-44 truncate text-body text-secondary"
                    title={wallet ?? undefined}
                  >
                    {wallet ?? <span className="text-tertiary">—</span>}
                  </TableCell>
                  <TableCell className="text-body whitespace-nowrap text-secondary">
                    {formatDateTime(transaction.createdAt, locale)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <ArrowPagination
        className="mt-4"
        page={pagination.page}
        pageCount={pagination.pageCount}
        disabled={pending}
        onPageChange={pagination.goToPage}
      />
    </section>
  );
}
