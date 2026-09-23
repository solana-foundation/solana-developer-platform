"use client";

import type {
  MoneygramTransferDetails,
  PaymentTransferSummary,
  PaymentTransferType,
  RampProviderId,
} from "@sdp/types";
import {
  ArrowRightIcon,
  BanknoteArrowDownIcon,
  BanknoteArrowUpIcon,
  ExternalLinkIcon,
  ReceiptTextIcon,
} from "lucide-react";
import Image from "next/image";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { WalletMetadataCopyButton } from "@/app/dashboard/custody/wallet-address-copy-button";
import { MemoJsonView } from "@/app/dashboard/payments/wizard-summary-list";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ListEmptyState } from "@/components/ui/list-empty-state";
import { Modal } from "@/components/ui/modal";
import { useTranslations } from "@/i18n/provider";
import { explorerTxUrl } from "@/lib/explorer";
import { getRampProviderLabel, RAMP_PROVIDER_LOGOS } from "@/lib/ramps";
import { useSolanaCluster } from "@/lib/use-solana-cluster";
import { cn } from "@/lib/utils";
import { formatRelativeTime, toTitleCase } from "../../activity-format-utils";
import {
  formatDisplayAmount,
  formatPaymentTransferType,
  formatTimestamp,
  resolveTransferFlow,
  shortenAddress,
  statusMessageKey,
  statusVariant,
} from "../payments-overview.utils";
import { providerTransferDetailRows } from "../provider-transfer-details";

function isInboundTransfer(transfer: PaymentTransferSummary): boolean {
  return transfer.type === "onramp" || transfer.direction === "inbound";
}

function TransferStatusBadge({ status }: { status: PaymentTransferSummary["status"] }) {
  const t = useTranslations();
  return <Badge variant={statusVariant(status)}>{t(statusMessageKey(status))}</Badge>;
}

function TransferProviderCell({ provider }: { provider: RampProviderId | undefined }) {
  if (provider === undefined) {
    return <span className="text-sm text-tertiary">—</span>;
  }
  return (
    <div className="flex items-center gap-2">
      <Image
        src={RAMP_PROVIDER_LOGOS[provider]}
        alt=""
        width={20}
        height={20}
        className="size-5 rounded"
      />
      <span className="text-sm text-primary">{getRampProviderLabel(provider)}</span>
    </div>
  );
}

function TransferTableRow({
  transfer,
  onSelect,
}: {
  transfer: PaymentTransferSummary;
  onSelect: (transfer: PaymentTransferSummary) => void;
}) {
  const t = useTranslations();
  const isInbound = isInboundTransfer(transfer);
  const walletAddress = isInbound ? transfer.destination : transfer.source;
  const flow = resolveTransferFlow(transfer);

  return (
    // biome-ignore lint/a11y/useSemanticElements: a table row can't be a <button>; role+key handler is the accessible compromise
    <tr
      role="button"
      tabIndex={0}
      onClick={() => onSelect(transfer)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(transfer);
        }
      }}
      className="cursor-pointer border-b border-border-default transition-colors last:border-b-0 hover:bg-fill-subtle"
    >
      <td className="whitespace-nowrap px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-fill-strong text-secondary [&_svg]:size-4">
            {isInbound ? <BanknoteArrowDownIcon /> : <BanknoteArrowUpIcon />}
          </span>
          <span className="text-sm font-medium text-primary">
            {formatPaymentTransferType(transfer.type, t)}
          </span>
        </div>
      </td>
      <td className="whitespace-nowrap px-4 py-3">
        <TransferProviderCell provider={transfer.provider} />
      </td>
      <td className="whitespace-nowrap px-4 py-3">
        {walletAddress ? (
          <span className="font-mono text-xs text-secondary" title={walletAddress}>
            {shortenAddress(walletAddress)}
          </span>
        ) : (
          <span className="text-sm text-tertiary">—</span>
        )}
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-right">
        {flow.send || flow.receive ? (
          <span className="inline-flex items-center justify-end gap-1.5 text-sm">
            {flow.send ? <span className="text-secondary">{flow.send}</span> : null}
            {flow.send && flow.receive ? (
              <ArrowRightIcon className="size-3.5 text-tertiary" />
            ) : null}
            {flow.receive ? <span className="font-medium text-primary">{flow.receive}</span> : null}
          </span>
        ) : (
          <span className="text-sm text-tertiary">—</span>
        )}
      </td>
      <td className="whitespace-nowrap px-4 py-3">
        <TransferStatusBadge status={transfer.status} />
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-right text-xs text-tertiary">
        {transfer.createdAt ? (
          <span title={formatTimestamp(transfer.createdAt, t)}>
            {formatRelativeTime(transfer.createdAt)}
          </span>
        ) : null}
      </td>
    </tr>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        active
          ? "border-primary bg-primary text-on-primary"
          : "border-border-default bg-surface-raised text-secondary hover:text-primary"
      )}
    >
      {children}
    </button>
  );
}

function DetailRow({
  label,
  value,
  mono,
  copyValue,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
  copyValue?: string;
}) {
  return (
    <div className="flex h-12 items-center justify-between gap-4">
      <span className="shrink-0 text-sm text-tertiary">{label}</span>
      <div className="flex min-w-0 items-center gap-1.5">
        <span className={cn("truncate text-sm text-primary", mono && "font-mono text-xs")}>
          {value}
        </span>
        {copyValue ? <WalletMetadataCopyButton value={copyValue} label={label} /> : null}
      </div>
    </div>
  );
}

function MoneygramDetailRows({
  moneygram,
  fiatCurrency,
}: {
  moneygram: MoneygramTransferDetails;
  fiatCurrency: string | undefined;
}) {
  const t = useTranslations();
  return (
    <>
      {moneygram.referenceNumber ? (
        <DetailRow
          label={t("DashboardPayments.transferDetails.cashPickupCode")}
          value={moneygram.referenceNumber}
          mono
          copyValue={moneygram.referenceNumber}
        />
      ) : null}
      {moneygram.transactionId ? (
        <DetailRow
          label={t("DashboardPayments.transferDetails.moneygramTransactionId")}
          value={moneygram.transactionId}
          mono
          copyValue={moneygram.transactionId}
        />
      ) : null}
      {moneygram.payoutStatus ? (
        <DetailRow
          label={t("DashboardPayments.transferDetails.payoutStatus")}
          value={toTitleCase(moneygram.payoutStatus)}
        />
      ) : null}
      {moneygram.payoutAmount !== undefined && fiatCurrency ? (
        <DetailRow
          label={t("DashboardPayments.transferDetails.payoutAmount")}
          value={formatDisplayAmount(String(moneygram.payoutAmount), fiatCurrency)}
        />
      ) : null}
      {moneygram.cryptoTransferId ? (
        <DetailRow
          label={t("DashboardPayments.transferDetails.cryptoTransferId")}
          value={moneygram.cryptoTransferId}
          mono
          copyValue={moneygram.cryptoTransferId}
        />
      ) : null}
      {moneygram.solanaTxSignature ? (
        <DetailRow
          label={t("DashboardPayments.transferDetails.solanaSignature")}
          value={shortenAddress(moneygram.solanaTxSignature)}
          mono
          copyValue={moneygram.solanaTxSignature}
        />
      ) : null}
      {moneygram.lastWidgetError ? (
        <DetailRow
          label={t("DashboardPayments.transferDetails.moneygramError")}
          value={moneygram.lastWidgetError}
        />
      ) : null}
    </>
  );
}

function TransferDetailRows({
  transfer,
  counterpartyName,
  onViewMemoJson,
}: {
  transfer: PaymentTransferSummary;
  counterpartyName: string;
  onViewMemoJson: () => void;
}) {
  const t = useTranslations();
  const cluster = useSolanaCluster();
  const isInbound = isInboundTransfer(transfer);
  const walletAddress = isInbound ? transfer.destination : transfer.source;
  const counterpartyParty = transfer.fiatCurrency
    ? `${counterpartyName} · ${transfer.fiatCurrency.toUpperCase()}`
    : counterpartyName;

  const walletRow = walletAddress ? (
    <DetailRow
      label={isInbound ? t("DashboardPayments.requests.to") : t("DashboardPayments.requests.from")}
      value={shortenAddress(walletAddress)}
      mono
      copyValue={walletAddress}
    />
  ) : null;
  const counterpartyRow = (
    <DetailRow
      label={isInbound ? t("DashboardPayments.requests.from") : t("DashboardPayments.requests.to")}
      value={counterpartyParty}
    />
  );

  return (
    <div className="rounded-2xl border border-border-default px-4 py-1">
      {isInbound ? (
        <>
          {walletRow}
          {counterpartyRow}
        </>
      ) : (
        <>
          {counterpartyRow}
          {walletRow}
        </>
      )}
      {transfer.provider ? (
        <DetailRow
          label={t("DashboardPayments.transferDetails.provider")}
          value={<TransferProviderCell provider={transfer.provider} />}
        />
      ) : null}
      <DetailRow
        label={t("DashboardPayments.transferDetails.transactionId")}
        value={transfer.id}
        mono
        copyValue={transfer.id}
      />
      {transfer.providerReference ? (
        <DetailRow
          label={t("DashboardPayments.transferDetails.providerReference")}
          value={transfer.providerReference}
          mono
          copyValue={transfer.providerReference}
        />
      ) : null}
      {transfer.status === "failed" && transfer.error ? (
        <DetailRow
          label={t("DashboardPayments.transferDetails.failureReason")}
          value={transfer.error}
        />
      ) : null}
      {transfer.memo ? (
        <DetailRow label={t("DashboardPayments.transferDetails.memo")} value={transfer.memo} />
      ) : null}
      {Object.keys(transfer.rampsMemo).length > 0 ? (
        <DetailRow
          label={t("DashboardPayments.transferDetails.memo")}
          value={
            <Button type="button" size="xs" onClick={onViewMemoJson}>
              {t("DashboardPayments.ramps.memoViewJson")}
            </Button>
          }
        />
      ) : null}
      {providerTransferDetailRows(transfer, { cluster }, t).map((row) => (
        <DetailRow
          key={row.key}
          label={row.label}
          value={
            row.href ? (
              <a
                href={row.href}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
              >
                {row.value}
                <ExternalLinkIcon className="size-3.5" />
              </a>
            ) : (
              row.value
            )
          }
          mono={row.mono}
          copyValue={row.copyValue}
        />
      ))}
      {transfer.moneygram !== undefined ? (
        <MoneygramDetailRows moneygram={transfer.moneygram} fiatCurrency={transfer.fiatCurrency} />
      ) : null}
      {transfer.updatedAt ? (
        <DetailRow
          label={t("DashboardPayments.transferDetails.lastUpdated")}
          value={formatTimestamp(transfer.updatedAt, t)}
        />
      ) : null}
    </div>
  );
}

function TransferDetailModal({
  transfer,
  counterpartyName,
  onClose,
}: {
  transfer: PaymentTransferSummary;
  counterpartyName: string;
  onClose: () => void;
}) {
  const t = useTranslations();
  const cluster = useSolanaCluster();
  const [memoJsonOpen, setMemoJsonOpen] = useState(false);
  const isInbound = isInboundTransfer(transfer);
  const signature =
    transfer.signature !== null ? transfer.signature : transfer.moneygram?.solanaTxSignature;
  const flow = resolveTransferFlow(transfer);

  return (
    <Modal
      isOpen
      ariaLabel={t("DashboardPayments.counterparty.transactionDetails")}
      onClose={onClose}
      size="lg"
    >
      <div className="space-y-5 p-6">
        <div className="flex items-start justify-between gap-4 pr-8">
          <div className="space-y-1">
            <h2 className="text-xl font-medium tracking-tight text-primary">
              {formatPaymentTransferType(transfer.type, t)}
            </h2>
            {transfer.createdAt ? (
              <p className="text-sm text-secondary">{formatTimestamp(transfer.createdAt, t)}</p>
            ) : null}
          </div>
          <TransferStatusBadge status={transfer.status} />
        </div>

        <div className="flex items-center justify-between gap-4 rounded-2xl bg-fill-subtle p-5">
          <div className="min-w-0 space-y-0.5">
            <p className="text-xs font-medium uppercase tracking-wide text-secondary">
              {isInbound
                ? t("DashboardPayments.counterparty.youDeposit")
                : t("DashboardPayments.counterparty.youSend")}
            </p>
            <p className="truncate text-xl font-semibold tracking-tight text-primary">
              {flow.send === null ? "—" : flow.send}
            </p>
          </div>
          <ArrowRightIcon className="size-5 shrink-0 text-tertiary" />
          <div className="min-w-0 space-y-0.5 text-right">
            <p className="text-xs font-medium uppercase tracking-wide text-secondary">
              {t("DashboardPayments.counterparty.recipientGets")}
            </p>
            <p className="truncate text-xl font-semibold tracking-tight text-primary">
              {flow.receive === null ? "—" : flow.receive}
            </p>
          </div>
        </div>

        <TransferDetailRows
          transfer={transfer}
          counterpartyName={counterpartyName}
          onViewMemoJson={() => setMemoJsonOpen(true)}
        />

        {signature ? (
          <Button
            type="button"
            variant="secondary"
            className="w-full"
            iconLeft={<ExternalLinkIcon className="size-4" />}
            onClick={() =>
              window.open(explorerTxUrl(signature, cluster), "_blank", "noopener,noreferrer")
            }
          >
            {t("DashboardPayments.counterparty.viewOnExplorer")}
          </Button>
        ) : null}
      </div>

      <Modal
        isOpen={memoJsonOpen}
        onClose={() => setMemoJsonOpen(false)}
        ariaLabel={t("DashboardPayments.ramps.memoJsonTitle")}
        size="lg"
      >
        <div className="p-6">
          <MemoJsonView json={transfer.rampsMemo} />
        </div>
      </Modal>
    </Modal>
  );
}

const TRANSFER_TABLE_COLUMNS = [
  { key: "transferType", align: "left", width: "12%" },
  { key: "transferProvider", align: "left", width: "16%" },
  { key: "transferWallet", align: "left", width: "15%" },
  { key: "transferAmount", align: "right", width: "28%" },
  { key: "transferStatus", align: "left", width: "13%" },
  { key: "transferDate", align: "right", width: "16%" },
] as const satisfies readonly { key: string; align: "left" | "right"; width: string }[];

/**
 * Filterable table of the counterparty's transfers with a per-row detail modal.
 *
 * @param props.transfers - Transfers already scoped to this counterparty.
 * @param props.counterpartyName - Display name shown as the fiat-side party in the detail modal.
 * @returns The transactions section.
 */
export function CounterpartyTransactions({
  transfers,
  counterpartyName,
}: {
  transfers: PaymentTransferSummary[];
  counterpartyName: string;
}) {
  const t = useTranslations();
  const [typeFilter, setTypeFilter] = useState<PaymentTransferType | null>(null);
  const [providerFilter, setProviderFilter] = useState<RampProviderId | null>(null);
  const [selectedTransfer, setSelectedTransfer] = useState<PaymentTransferSummary | null>(null);

  const availableTypes = useMemo(
    () => [...new Set(transfers.flatMap((transfer) => (transfer.type ? [transfer.type] : [])))],
    [transfers]
  );
  const availableProviders = useMemo(
    () => [
      ...new Set(transfers.flatMap((transfer) => (transfer.provider ? [transfer.provider] : []))),
    ],
    [transfers]
  );
  const filteredTransfers = useMemo(
    () =>
      transfers.filter(
        (transfer) =>
          (typeFilter === null || transfer.type === typeFilter) &&
          (providerFilter === null || transfer.provider === providerFilter)
      ),
    [transfers, typeFilter, providerFilter]
  );

  if (transfers.length === 0) {
    return (
      <ListEmptyState
        className="min-h-0 rounded-lg border border-dashed border-border-strong py-10"
        icon={<ReceiptTextIcon className="size-5" />}
        message={t("DashboardPayments.counterparty.noTransactions")}
      />
    );
  }

  return (
    <section className="space-y-3">
      {availableTypes.length > 1 || availableProviders.length > 1 ? (
        <div className="flex flex-wrap items-center gap-2">
          {availableTypes.length > 1 ? (
            <>
              <FilterChip active={typeFilter === null} onClick={() => setTypeFilter(null)}>
                {t("DashboardPayments.counterparty.allTypes")}
              </FilterChip>
              {availableTypes.map((type) => (
                <FilterChip
                  key={type}
                  active={typeFilter === type}
                  onClick={() => setTypeFilter(type)}
                >
                  {formatPaymentTransferType(type, t)}
                </FilterChip>
              ))}
            </>
          ) : null}
          {availableProviders.length > 1 ? (
            <>
              <span className="mx-1 h-4 w-px bg-fill-strong" />
              <FilterChip active={providerFilter === null} onClick={() => setProviderFilter(null)}>
                {t("DashboardPayments.counterparty.allProviders")}
              </FilterChip>
              {availableProviders.map((provider) => (
                <FilterChip
                  key={provider}
                  active={providerFilter === provider}
                  onClick={() => setProviderFilter(provider)}
                >
                  {getRampProviderLabel(provider)}
                </FilterChip>
              ))}
            </>
          ) : null}
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-border-default bg-surface-raised">
        <table className="w-full min-w-[48rem] table-fixed border-collapse">
          <thead>
            <tr className="border-b border-border-default">
              {TRANSFER_TABLE_COLUMNS.map((column) => (
                <th
                  key={column.key}
                  style={{ width: column.width }}
                  className={cn(
                    "px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-secondary",
                    column.align === "right" ? "text-right" : "text-left"
                  )}
                >
                  {t(`DashboardPayments.counterparty.${column.key}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredTransfers.length === 0 ? (
              <tr>
                <td
                  colSpan={TRANSFER_TABLE_COLUMNS.length}
                  className="px-4 py-8 text-center text-sm text-tertiary"
                >
                  {t("DashboardPayments.counterparty.noFilteredTransactions")}
                </td>
              </tr>
            ) : (
              filteredTransfers.map((transfer) => (
                <TransferTableRow
                  key={transfer.id}
                  transfer={transfer}
                  onSelect={setSelectedTransfer}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      {selectedTransfer !== null ? (
        <TransferDetailModal
          key={selectedTransfer.id}
          transfer={selectedTransfer}
          counterpartyName={counterpartyName}
          onClose={() => setSelectedTransfer(null)}
        />
      ) : null}
    </section>
  );
}
