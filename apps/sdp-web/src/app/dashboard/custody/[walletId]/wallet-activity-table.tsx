"use client";

import type { WalletActivityRow } from "@/app/dashboard/custody/wallet-activity.data";
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
import { toTitleCase } from "../../activity-format-utils";
import { resolveTransferTokenLabel, shortenAddress } from "../../payments/payments-overview.utils";
import { formatDate } from "../../payments/payments-presentation";
import { PAYMENTS_TABLE_CELL, PAYMENTS_TABLE_HEAD } from "../../payments/payments-table";

const SETTLED = new Set(["confirmed", "finalized", "completed", "succeeded", "success"]);
const FAILED = new Set(["failed", "rejected", "canceled", "cancelled", "expired"]);

function statusTone(status: string): StatusTone {
  const normalized = status.toLowerCase();
  if (SETTLED.has(normalized)) return "positive";
  if (FAILED.has(normalized)) return "critical";
  return "progress";
}

/** The transfer or transaction id the row carries, without the feed's source prefix. */
export function activityDisplayId(id: string): string {
  const bare = id.replace(/^(payment|issuance)-/, "");
  return bare.length > 14 ? `${bare.slice(0, 8)}…${bare.slice(-4)}` : bare;
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
  rows: readonly WalletActivityRow[];
  symbols: Record<string, string>;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const incoming = t("DashboardCustody.incoming");
  const outgoing = t("DashboardCustody.outgoing");
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
          {rows.map((row) => {
            const sign =
              row.operationLabel === incoming ? "+" : row.operationLabel === outgoing ? "−" : "";
            const token = row.token ? resolveTransferTokenLabel(row.token, symbols) : "";
            return (
              <TableRow key={row.id} data-wallet-activity-row={row.id}>
                <TableCell className={PAYMENTS_TABLE_CELL}>
                  <span className="block truncate font-medium text-primary">
                    {row.operationLabel}
                  </span>
                  <span className="block truncate text-tertiary tabular-nums" title={row.id}>
                    {activityDisplayId(row.id)}
                  </span>
                </TableCell>
                <TableCell className={PAYMENTS_TABLE_CELL}>
                  <StatusText tone={statusTone(row.status)} className={PAYMENTS_TABLE_CELL}>
                    {toTitleCase(row.status)}
                  </StatusText>
                </TableCell>
                <TableCell
                  className={cn(
                    PAYMENTS_TABLE_CELL,
                    "truncate text-right whitespace-nowrap text-primary tabular-nums"
                  )}
                >
                  {row.amount ? (
                    `${sign}${row.amount}${token ? ` ${token}` : ""}`
                  ) : (
                    <span className="text-tertiary">—</span>
                  )}
                </TableCell>
                <TableCell className={cn(PAYMENTS_TABLE_CELL, "truncate text-primary")}>
                  {row.address ? (
                    <span title={row.address}>{shortenAddress(row.address)}</span>
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
                  {formatDate(row.createdAt, locale) ?? "—"}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
