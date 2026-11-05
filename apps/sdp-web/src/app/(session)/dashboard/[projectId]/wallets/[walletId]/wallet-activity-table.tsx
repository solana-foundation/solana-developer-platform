"use client";

import { cn } from "@sdp/ui/cn";
import { StatusText, type StatusTone } from "@sdp/ui/status-text";
import { TableCell } from "@sdp/ui/table";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@solana/design-system/table";
import { ArrowUpRightIcon } from "lucide-react";
import { Fragment, type ReactNode, useId } from "react";
import { toTitleCase } from "@/app/(session)/dashboard/[projectId]/activity-format-utils";
import {
  resolveTransferTokenLabel,
  shortenAddress,
} from "@/app/(session)/dashboard/[projectId]/payments/payments-overview.utils";
import { formatDate } from "@/app/(session)/dashboard/[projectId]/payments/payments-presentation";
import {
  PAYMENTS_TABLE_CELL,
  PAYMENTS_TABLE_HEAD,
} from "@/app/(session)/dashboard/[projectId]/payments/payments-table";
import type { WalletActivityRow } from "@/app/(session)/dashboard/[projectId]/wallets/wallet-activity.data";
import { WalletMetadataCopyButton } from "@/app/(session)/dashboard/[projectId]/wallets/wallet-address-copy-button";
import { truncateMiddle } from "@/app/(session)/dashboard/[projectId]/wallets/wallet-format-utils";
import { RowDisclosureButton } from "@/components/row-disclosure-button";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import { explorerTxUrl } from "@/lib/explorer";
import { useOpenRow } from "@/lib/use-open-row";
import { useSolanaCluster } from "@/lib/use-solana-cluster";
import { activityDisplayId } from "./wallet-detail.shared";

const SETTLED = new Set(["confirmed", "finalized", "completed", "succeeded", "success"]);
const FAILED = new Set(["failed", "rejected", "canceled", "cancelled", "expired"]);

function statusTone(status: string): StatusTone {
  const normalized = status.toLowerCase();
  if (SETTLED.has(normalized)) return "positive";
  if (FAILED.has(normalized)) return "critical";
  return "progress";
}

/** Why a row has no signature, by how its status reads: not yet while it moves, else none. */
function noSignatureKey(tone: StatusTone): MessageKey {
  switch (tone) {
    case "progress":
      return "DashboardCustody.walletActivityNoSignatureYet";
    case "positive":
    case "attention":
    case "critical":
    case "neutral":
      return "DashboardCustody.walletActivityNoSignature";
    default: {
      const unreachable: never = tone;
      return unreachable;
    }
  }
}

/** A detail under an open row: a 13px label over its value, with a copy of the whole. */
function DetailFact({
  label,
  copy,
  children,
}: {
  label: string;
  copy?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-meta text-tertiary">{label}</span>
      <span className="flex min-w-0 items-center gap-1.5 text-meta text-primary tabular-nums">
        <span className="truncate">{children}</span>
        {copy ? <WalletMetadataCopyButton value={copy} label={label} /> : null}
      </span>
    </div>
  );
}

/**
 * What an open row adds, as the design lays it under the row: the signature under the
 * transaction, the address on the other side under the counterparty, and the explorer link at
 * the end. A row with no signature says why there is none.
 */
function WalletActivityDetails({ row }: { row: WalletActivityRow }) {
  const t = useTranslations();
  const cluster = useSolanaCluster();
  const noSignature = t(noSignatureKey(statusTone(row.status)));
  return (
    <div className="grid gap-x-6 gap-y-3 @2xl:grid-cols-[35%_21%_minmax(0,1fr)_max-content] @2xl:items-end @2xl:gap-x-0">
      <div className="min-w-0 @2xl:pe-6">
        <DetailFact label={t("DashboardCustody.signature")} copy={row.signature ?? undefined}>
          {row.signature ? (
            truncateMiddle(row.signature, 8, 8)
          ) : (
            <span className="text-tertiary">{noSignature}</span>
          )}
        </DetailFact>
      </div>
      {row.address ? (
        <div className="min-w-0 @2xl:col-start-3 @2xl:pe-6">
          <DetailFact
            label={t(
              row.sourceKind === "payments"
                ? "DashboardCustody.walletActivityCounterpartyAddress"
                : "DashboardCustody.address"
            )}
            copy={row.address}
          >
            {shortenAddress(row.address)}
          </DetailFact>
        </div>
      ) : null}
      {row.signature ? (
        <a
          href={explorerTxUrl(row.signature, cluster)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 justify-self-start text-meta text-primary underline decoration-border-strong underline-offset-4 hover:decoration-current @2xl:col-start-4 @2xl:justify-self-end"
        >
          {t("DashboardCustody.walletActivityViewOnExplorer")}
          <ArrowUpRightIcon aria-hidden="true" className="size-3.5" />
        </a>
      ) : null}
    </div>
  );
}

/**
 * A wallet's activity as the design lists it: the transaction (what happened over its id),
 * its status in the status's ink, the amount signed by direction, who was on the other side
 * and when. A row opens, from its chevron or anywhere on it, to its signature, the address on
 * the other side and the explorer; one row is open at a time.
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
  const detailsId = useId();
  const openRow = useOpenRow();
  const incoming = t("DashboardCustody.incoming");
  const outgoing = t("DashboardCustody.outgoing");
  const detailsLabel = t("DashboardCustody.walletActivityDetails");
  return (
    <div className="overflow-x-auto -mx-3">
      <Table
        className="min-w-[47.5rem] rounded-none border-0 [&_table]:table-fixed"
        data-wallet-activity-table
      >
        <TableHeader>
          <TableRow>
            <TableHead className={cn(PAYMENTS_TABLE_HEAD, "w-[21%]")}>
              {t("DashboardCustody.walletTransaction")}
            </TableHead>
            <TableHead className={cn(PAYMENTS_TABLE_HEAD, "w-[14%]")}>
              {t("DashboardCustody.status")}
            </TableHead>
            <TableHead className={cn(PAYMENTS_TABLE_HEAD, "w-[21%] text-right")}>
              {t("DashboardCustody.walletAmount")}
            </TableHead>
            <TableHead className={cn(PAYMENTS_TABLE_HEAD, "w-[26%]")}>
              {t("DashboardCustody.counterparty")}
            </TableHead>
            <TableHead className={cn(PAYMENTS_TABLE_HEAD, "w-[13%]")}>
              {t("DashboardCustody.created")}
            </TableHead>
            <TableHead className={cn(PAYMENTS_TABLE_HEAD, "w-[5%]")}>
              <span className="sr-only">{detailsLabel}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, index) => {
            const sign =
              row.operationLabel === incoming ? "+" : row.operationLabel === outgoing ? "−" : "";
            const token = row.token ? resolveTransferTokenLabel(row.token, symbols) : "";
            const open = openRow.isOpen(row.id);
            const toggle = () => openRow.toggle(row.id);
            const detailId = `${detailsId}-${index}`;
            return (
              <Fragment key={row.id}>
                <TableRow
                  data-wallet-activity-row={row.id}
                  data-state={open ? "selected" : undefined}
                  className={cn("cursor-pointer", open && "border-b-0")}
                  onClick={toggle}
                >
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
                  <TableCell className={cn(PAYMENTS_TABLE_CELL, "text-right")}>
                    <RowDisclosureButton
                      open={open}
                      controls={detailId}
                      label={detailsLabel}
                      onToggle={toggle}
                    />
                  </TableCell>
                </TableRow>
                {open ? (
                  <TableRow id={detailId} data-state="selected" data-wallet-activity-details>
                    <TableCell colSpan={6} className="whitespace-normal pt-1 pb-3">
                      <WalletActivityDetails row={row} />
                    </TableCell>
                  </TableRow>
                ) : null}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
