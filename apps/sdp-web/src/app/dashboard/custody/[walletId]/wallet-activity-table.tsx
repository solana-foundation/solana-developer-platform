"use client";

import type { UnifiedTransaction, UnifiedTransactionKind } from "@sdp/types";
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
import { cn } from "@/lib/utils";
import { resolveTransferTokenLabel, shortenAddress } from "../../payments/payments-overview.utils";
import { formatDate, formatDecimalAmount } from "../../payments/payments-presentation";
import { PAYMENTS_TABLE_CELL, PAYMENTS_TABLE_HEAD } from "../../payments/payments-table";
import { kindLabel, useTransactionStatus } from "../../payments/transactions/transaction-status";
import { activityDisplayId } from "./wallet-detail.shared";

/** Which way a payment moved the wallet's balance; every payments kind has a side. */
const SIGN_BY_PAYMENT_KIND = {
  pay: "−",
  confidential_pay: "−",
  batch_pay: "−",
  recurring_pay: "−",
  offramp: "−",
  deposit: "+",
  request_deposit: "+",
  onramp: "+",
} as const satisfies Record<UnifiedTransactionKind<"payments">, "+" | "−">;

function amountSign(transaction: UnifiedTransaction): string {
  return transaction.module === "payments" ? SIGN_BY_PAYMENT_KIND[transaction.kind] : "";
}

/**
 * A wallet's activity as the design lists it: the transaction (what happened over its id),
 * its status in the status's ink, the amount signed by direction, who was on the other side
 * and when.
 */
export function WalletActivityTable({
  rows,
  symbols,
}: {
  rows: readonly UnifiedTransaction[];
  symbols: Record<string, string>;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const statusOf = useTransactionStatus();
  return (
    <div className="overflow-x-auto refresh:-mx-3">
      <Table
        className="min-w-[760px] rounded-none border-0 [&_table]:table-fixed"
        data-wallet-activity-table
      >
        <TableHeader>
          <TableRow>
            <TableHead className={cn(PAYMENTS_TABLE_HEAD, "w-[22%]")}>
              {t("DashboardCustody.walletTransaction")}
            </TableHead>
            <TableHead className={cn(PAYMENTS_TABLE_HEAD, "w-[14%]")}>
              {t("DashboardCustody.status")}
            </TableHead>
            <TableHead className={cn(PAYMENTS_TABLE_HEAD, "w-[22%] text-right")}>
              {t("DashboardCustody.walletAmount")}
            </TableHead>
            <TableHead className={cn(PAYMENTS_TABLE_HEAD, "w-[26%]")}>
              {t("DashboardCustody.counterparty")}
            </TableHead>
            <TableHead className={cn(PAYMENTS_TABLE_HEAD, "w-[16%]")}>
              {t("DashboardCustody.created")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((transaction) => {
            const status = statusOf(transaction);
            const token = transaction.token
              ? resolveTransferTokenLabel(transaction.token, symbols)
              : "";
            return (
              <TableRow
                key={`${transaction.module}:${transaction.id}`}
                data-wallet-activity-row={transaction.id}
              >
                <TableCell className={PAYMENTS_TABLE_CELL}>
                  <span className="block truncate font-medium text-primary">
                    {kindLabel(t, transaction)}
                  </span>
                  <span
                    className="block truncate text-tertiary tabular-nums"
                    title={transaction.id}
                  >
                    {activityDisplayId(transaction.id)}
                  </span>
                </TableCell>
                <TableCell className={PAYMENTS_TABLE_CELL}>
                  <StatusText tone={status.tone} className={PAYMENTS_TABLE_CELL}>
                    {status.label}
                  </StatusText>
                </TableCell>
                <TableCell
                  className={cn(
                    PAYMENTS_TABLE_CELL,
                    "truncate text-right whitespace-nowrap text-primary tabular-nums"
                  )}
                >
                  {transaction.amount ? (
                    `${amountSign(transaction)}${formatDecimalAmount(transaction.amount, locale)}${token ? ` ${token}` : ""}`
                  ) : (
                    <span className="text-tertiary">—</span>
                  )}
                </TableCell>
                <TableCell className={cn(PAYMENTS_TABLE_CELL, "truncate text-primary")}>
                  {transaction.counterpartyAddress ? (
                    <span title={transaction.counterpartyAddress}>
                      {shortenAddress(transaction.counterpartyAddress)}
                    </span>
                  ) : (
                    <span className="text-tertiary">—</span>
                  )}
                </TableCell>
                <TableCell
                  className={cn(
                    PAYMENTS_TABLE_CELL,
                    "whitespace-nowrap text-secondary tabular-nums"
                  )}
                >
                  {formatDate(transaction.createdAt, locale) ?? "—"}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
