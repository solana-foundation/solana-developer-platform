"use client";

import type { PaymentTransferSummary } from "@sdp/types";
import { ExternalLinkIcon, ReceiptTextIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ListEmptyState } from "@/components/ui/list-empty-state";
import { Modal } from "@/components/ui/modal";
import { PaginatedFooter } from "@/components/ui/paginated-footer";
import { SkeletonBlock } from "@/components/ui/skeleton-block";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useLocale, useTranslations } from "@/i18n/provider";
import { explorerTxUrl } from "@/lib/explorer";
import { useSolanaCluster } from "@/lib/use-solana-cluster";
import { cn } from "@/lib/utils";
import {
  formatDirection,
  formatDisplayAmount,
  formatTimestamp,
  resolveTransferTokenLabel,
  resolveTransferTypeLabel,
  shortenAddress,
} from "../payments-overview.utils";
import { TransactionAmount } from "./transactions-amount";
import {
  getTransactionCounterpartyPresentation,
  retainTransactionCounterpartyDisplayName,
} from "./transactions-counterparty";
import type { TransactionsPageResult } from "./transactions-page.data";
import type { TransactionFilters } from "./transactions-query";
import { useTransactionFilters } from "./transactions-workspace";

const DETAIL_SKELETON_ROWS = [
  "status",
  "type",
  "amount",
  "wallet",
  "counterparty",
  "source",
  "destination",
] as const;

function statusVariant(status: string): BadgeVariant {
  if (["completed", "confirmed", "finalized"].includes(status)) return "success";
  if (["pending", "processing", "awaiting_payment", "settling"].includes(status)) {
    return "warning";
  }
  if (status === "failed") return "danger";
  return "default";
}

function formatStatus(status: string): string {
  return status
    .split("_")
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function TransactionIdentity({
  transfer,
  onSelect,
}: {
  transfer: PaymentTransferSummary;
  onSelect: (transfer: PaymentTransferSummary) => void;
}) {
  const t = useTranslations();
  return (
    <button
      type="button"
      onClick={() => onSelect(transfer)}
      aria-label={t("DashboardPayments.transactions.viewDetails", { id: transfer.id })}
      className="group flex min-w-0 items-center gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-black/40 focus-visible:ring-offset-2"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-fill-subtle text-secondary transition-colors group-hover:bg-fill-strong group-hover:text-primary">
        <ReceiptTextIcon className="size-4" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-primary">
          {resolveTransferTypeLabel(transfer.type, t)}
        </span>
        <span className="mt-0.5 block truncate font-mono text-xs text-tertiary" title={transfer.id}>
          {shortenAddress(transfer.id)}
        </span>
      </span>
    </button>
  );
}

function TransactionDetail({
  transfer,
  loading,
  error,
  issuedTokenSymbolsByMint,
}: {
  transfer: PaymentTransferSummary | null;
  loading: boolean;
  error: string | null;
  issuedTokenSymbolsByMint: Readonly<Record<string, string>>;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const cluster = useSolanaCluster();
  if (loading) {
    return (
      <div className="space-y-4 p-6" role="status">
        <span className="sr-only">{t("DashboardPayments.transactions.loadingDetails")}</span>
        <SkeletonBlock className="h-7 w-48" />
        {DETAIL_SKELETON_ROWS.map((row) => (
          <SkeletonBlock key={`transaction-detail-${row}`} className="h-12 w-full" />
        ))}
      </div>
    );
  }
  if (error || !transfer) {
    return (
      <p className="p-6 text-sm text-error">
        {error ?? t("DashboardPayments.transactions.detailLoadError")}
      </p>
    );
  }

  const counterparty = getTransactionCounterpartyPresentation(transfer);
  const rows = [
    [t("DashboardPayments.transactions.transactionId"), transfer.id],
    [t("DashboardPayments.transactions.status"), formatStatus(transfer.status)],
    [t("DashboardPayments.transactions.type"), resolveTransferTypeLabel(transfer.type, t)],
    [
      t("DashboardPayments.transactions.amount"),
      formatDisplayAmount(
        transfer.amount,
        resolveTransferTokenLabel(transfer.token, issuedTokenSymbolsByMint),
        locale
      ),
    ],
    [t("DashboardPayments.transactions.direction"), formatDirection(transfer.direction, t)],
    [t("DashboardPayments.transactions.wallet"), transfer.walletId],
    [
      t("DashboardPayments.transactions.counterparty"),
      counterparty.displayName ?? transfer.counterpartyId,
    ],
    [
      t("DashboardPayments.transactions.counterpartyId"),
      counterparty.displayName ? transfer.counterpartyId : undefined,
    ],
    [t("DashboardPayments.transactions.provider"), transfer.provider],
    [t("DashboardPayments.transactions.providerReference"), transfer.providerReference],
    [t("DashboardPayments.transactions.source"), transfer.source],
    [t("DashboardPayments.transactions.destination"), transfer.destination],
    [t("DashboardPayments.transactions.signature"), transfer.signature],
    [t("DashboardPayments.transactions.memo"), transfer.memo],
    [t("DashboardPayments.transactions.created"), formatTimestamp(transfer.createdAt, t, locale)],
    [t("DashboardPayments.transactions.updated"), formatTimestamp(transfer.updatedAt, t, locale)],
  ].filter((row): row is [string, string] => Boolean(row[1]));

  return (
    <div>
      <div className="border-b border-border-default p-6 pr-14">
        <h2 className="text-lg font-semibold text-primary">
          {t("DashboardPayments.transactions.details")}
        </h2>
        <div className="mt-3">
          <Badge variant={statusVariant(transfer.status)}>{formatStatus(transfer.status)}</Badge>
        </div>
      </div>
      <dl className="divide-y divide-border-default px-6">
        {rows.map(([label, value]) => (
          <div key={label} className="grid gap-1 py-3 sm:grid-cols-[150px_minmax(0,1fr)] sm:gap-4">
            <dt className="text-xs text-tertiary">{label}</dt>
            <dd className="break-all text-sm text-primary">{value}</dd>
          </div>
        ))}
      </dl>
      {transfer.signature ? (
        <div className="border-t border-border-default p-6">
          <Button asChild variant="outline" iconRight={<ExternalLinkIcon />}>
            <a href={explorerTxUrl(transfer.signature, cluster)} target="_blank" rel="noreferrer">
              {t("DashboardPayments.transactions.viewOnExplorer")}
            </a>
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function useTransactionDetail(selected: PaymentTransferSummary | null) {
  const t = useTranslations();
  const [detail, setDetail] = useState<PaymentTransferSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      setError(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`/api/dashboard/payments/transactions/${encodeURIComponent(selected.id)}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as {
          data?: { transfer?: PaymentTransferSummary };
          error?: { message?: string };
        };
        if (!response.ok || !body.data?.transfer) {
          throw new Error(
            body.error?.message ?? t("DashboardPayments.transactions.detailLoadError")
          );
        }
        setDetail(retainTransactionCounterpartyDisplayName(body.data.transfer, selected));
      })
      .catch((requestError) => {
        if (requestError instanceof DOMException && requestError.name === "AbortError") return;
        setError(
          requestError instanceof Error
            ? requestError.message
            : t("DashboardPayments.transactions.detailLoadError")
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [selected, t]);

  return { detail, error, loading };
}

function EmptyState({ filtered, onClear }: { filtered: boolean; onClear: () => void }) {
  const t = useTranslations();
  return (
    <ListEmptyState
      icon={<ReceiptTextIcon className="size-5" />}
      message={t(
        filtered
          ? "DashboardPayments.transactions.noMatches"
          : "DashboardPayments.transactions.emptyProject"
      )}
      action={
        filtered ? (
          <Button type="button" variant="secondary" onClick={onClear}>
            {t("DashboardPayments.transactions.clearFilters")}
          </Button>
        ) : null
      }
    />
  );
}

function DesktopTable({
  transfers,
  onSelect,
  issuedTokenSymbolsByMint,
}: {
  transfers: PaymentTransferSummary[];
  onSelect: (transfer: PaymentTransferSummary) => void;
  issuedTokenSymbolsByMint: Readonly<Record<string, string>>;
}) {
  const t = useTranslations();
  const locale = useLocale();
  return (
    <div className="hidden overflow-x-auto lg:block" data-transactions-desktop-table>
      <Table className="rounded-none border-0 [&_table]:min-w-[1040px] [&_table]:table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead className="w-[23%]">
              {t("DashboardPayments.transactions.transaction")}
            </TableHead>
            <TableHead className="w-[12%]">{t("DashboardPayments.transactions.status")}</TableHead>
            <TableHead className="w-[13%]">{t("DashboardPayments.transactions.amount")}</TableHead>
            <TableHead className="w-[10%]">
              {t("DashboardPayments.transactions.direction")}
            </TableHead>
            <TableHead className="w-[15%]">
              {t("DashboardPayments.transactions.counterparty")}
            </TableHead>
            <TableHead className="w-[13%]">{t("DashboardPayments.transactions.wallet")}</TableHead>
            <TableHead className="w-[14%]">{t("DashboardPayments.transactions.created")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {transfers.map((transfer) => {
            const counterparty = getTransactionCounterpartyPresentation(transfer);
            return (
              <TableRow key={transfer.id} data-testid={`transaction-row-${transfer.id}`}>
                <TableCell>
                  <TransactionIdentity transfer={transfer} onSelect={onSelect} />
                </TableCell>
                <TableCell>
                  <Badge variant={statusVariant(transfer.status)}>
                    {formatStatus(transfer.status)}
                  </Badge>
                </TableCell>
                <TableCell>
                  <TransactionAmount
                    transfer={transfer}
                    locale={locale}
                    issuedTokenSymbolsByMint={issuedTokenSymbolsByMint}
                    className="text-sm font-medium text-primary"
                  />
                </TableCell>
                <TableCell className="text-sm text-secondary">
                  {formatDirection(transfer.direction, t)}
                </TableCell>
                <TableCell className="min-w-0">
                  {/* primary is already shortened when there is no display
                      name, so titling it with itself showed the truncated
                      string again on hover. The reference is the full value. */}
                  <span
                    className="block truncate text-sm text-secondary"
                    title={counterparty.reference ?? counterparty.primary}
                  >
                    {counterparty.primary}
                  </span>
                  {counterparty.secondary ? (
                    <span
                      className="mt-0.5 block truncate font-mono text-xs text-tertiary"
                      title={counterparty.reference}
                    >
                      {counterparty.secondary}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell
                  className="truncate font-mono text-xs text-secondary"
                  title={transfer.walletId}
                >
                  {transfer.walletId ? shortenAddress(transfer.walletId) : "—"}
                </TableCell>
                <TableCell className="text-sm text-secondary">
                  <time dateTime={transfer.createdAt}>
                    {formatTimestamp(transfer.createdAt, t, locale)}
                  </time>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function MobileRows({
  transfers,
  onSelect,
  issuedTokenSymbolsByMint,
}: {
  transfers: PaymentTransferSummary[];
  onSelect: (transfer: PaymentTransferSummary) => void;
  issuedTokenSymbolsByMint: Readonly<Record<string, string>>;
}) {
  const t = useTranslations();
  const locale = useLocale();
  return (
    <div className="divide-y divide-border-default lg:hidden" data-transactions-mobile-rows>
      {transfers.map((transfer) => {
        const counterparty = getTransactionCounterpartyPresentation(transfer);
        return (
          <article key={transfer.id} className="space-y-4 p-4">
            <div className="flex items-start justify-between gap-3">
              <TransactionIdentity transfer={transfer} onSelect={onSelect} />
              <Badge variant={statusVariant(transfer.status)}>
                {formatStatus(transfer.status)}
              </Badge>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <div className="min-w-0">
                <p className="text-xs text-tertiary">
                  {t("DashboardPayments.transactions.amount")}
                </p>
                <TransactionAmount
                  transfer={transfer}
                  locale={locale}
                  issuedTokenSymbolsByMint={issuedTokenSymbolsByMint}
                  className="mt-1 font-medium text-primary"
                />
              </div>
              <div>
                <p className="text-xs text-tertiary">
                  {t("DashboardPayments.transactions.direction")}
                </p>
                <p className="mt-1 text-secondary">{formatDirection(transfer.direction, t)}</p>
              </div>
              <div className="min-w-0">
                <p className="text-xs text-tertiary">
                  {t("DashboardPayments.transactions.counterparty")}
                </p>
                <p
                  className="mt-1 truncate text-secondary"
                  title={counterparty.reference ?? counterparty.primary}
                >
                  {counterparty.primary}
                </p>
                {counterparty.secondary ? (
                  <p
                    className="mt-0.5 truncate font-mono text-xs text-tertiary"
                    title={counterparty.reference}
                  >
                    {counterparty.secondary}
                  </p>
                ) : null}
              </div>
              <div>
                <p className="text-xs text-tertiary">
                  {t("DashboardPayments.transactions.created")}
                </p>
                <p className="mt-1 text-secondary">
                  {formatTimestamp(transfer.createdAt, t, locale)}
                </p>
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}

export function TransactionsResults({
  result,
  serverFilters,
  issuedTokenSymbolsByMint,
}: {
  result: TransactionsPageResult;
  serverFilters: TransactionFilters;
  issuedTokenSymbolsByMint: Readonly<Record<string, string>>;
}) {
  const t = useTranslations();
  const router = useRouter();
  const { filters, isPending, clearFilters, updateFilters } = useTransactionFilters();
  const [selected, setSelected] = useState<PaymentTransferSummary | null>(null);
  const detailState = useTransactionDetail(selected);
  const pageCount = Math.max(1, Math.ceil(result.total / result.pageSize));
  const rangeStart = result.total ? (result.page - 1) * result.pageSize + 1 : 0;
  const rangeEnd = Math.min(result.page * result.pageSize, result.total);
  const filtered = useMemo(
    () =>
      Boolean(
        serverFilters.search ||
          serverFilters.status ||
          serverFilters.direction ||
          serverFilters.type ||
          serverFilters.walletId ||
          serverFilters.counterpartyId ||
          serverFilters.asset ||
          serverFilters.provider ||
          serverFilters.from ||
          serverFilters.to ||
          // Excluding observed deposits can be the sole reason a wallet looks
          // empty, so the empty state must offer to clear filters rather than
          // claim there is nothing to show.
          !serverFilters.includeObserved
      ),
    [serverFilters]
  );
  if (result.error) {
    return (
      <ListEmptyState
        message={t("DashboardPayments.transactions.loadError")}
        action={
          <Button type="button" variant="secondary" onClick={() => router.refresh()}>
            {t("DashboardPayments.transactions.retry")}
          </Button>
        }
      />
    );
  }

  return (
    <section
      className={cn("flex min-w-0 flex-1 flex-col transition-opacity", isPending && "opacity-60")}
      aria-busy={isPending}
    >
      {result.transfers.length === 0 ? (
        <EmptyState filtered={filtered} onClear={clearFilters} />
      ) : (
        <>
          <DesktopTable
            transfers={result.transfers}
            onSelect={setSelected}
            issuedTokenSymbolsByMint={issuedTokenSymbolsByMint}
          />
          <MobileRows
            transfers={result.transfers}
            onSelect={setSelected}
            issuedTokenSymbolsByMint={issuedTokenSymbolsByMint}
          />
          <PaginatedFooter
            className="mt-auto"
            page={result.page}
            pageCount={pageCount}
            disabled={isPending}
            onPageChange={(page) => updateFilters({ page }, { preserveSnapshot: true })}
            summary={t("DashboardPayments.transactions.range", {
              start: rangeStart,
              end: rangeEnd,
              total: result.total,
            })}
            pageSizeControl={{
              pageSize: filters.pageSize,
              onPageSizeChange: (pageSize) =>
                updateFilters({ pageSize, page: 1 }, { preserveSnapshot: true }),
            }}
          />
        </>
      )}
      <Modal
        isOpen={Boolean(selected)}
        onClose={() => setSelected(null)}
        ariaLabel={t("DashboardPayments.transactions.details")}
        size="xl"
      >
        <TransactionDetail
          transfer={detailState.detail}
          loading={detailState.loading}
          error={detailState.error}
          issuedTokenSymbolsByMint={issuedTokenSymbolsByMint}
        />
      </Modal>
    </section>
  );
}
