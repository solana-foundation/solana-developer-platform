"use client";

import type { PaymentTransferSummary } from "@sdp/types/payments";
import type { PersistedRampProviderId } from "@sdp/types/provider-access";
import { Badge } from "@sdp/ui/badge";
import { Button } from "@sdp/ui/button";
import { cn } from "@sdp/ui/cn";
import { Modal } from "@sdp/ui/modal";
import { ArrowRightIcon, ExternalLinkIcon } from "lucide-react";
import Image from "next/image";
import type { ReactNode } from "react";
import { useState } from "react";
import { WalletMetadataCopyButton } from "@/app/dashboard/[projectId]/custody/wallet-address-copy-button";
import {
  formatPaymentTransferType,
  formatTimestamp,
  resolveTransferFlow,
  shortenAddress,
  statusMessageKey,
  statusVariant,
} from "@/app/dashboard/[projectId]/payments/payments-overview.utils";
import { isInboundTransfer } from "@/app/dashboard/[projectId]/payments/payments-presentation";
import { providerTransferDetailRows } from "@/app/dashboard/[projectId]/payments/provider-transfer-details";
import { rampPhaseCopy } from "@/app/dashboard/[projectId]/payments/ramps/ramp-phase";
import { MemoJsonView } from "@/app/dashboard/[projectId]/payments/wizard-summary-list";
import { useLocale, useTranslations } from "@/i18n/provider";
import { explorerTxUrl } from "@/lib/explorer";
import { getRampProviderLabel, getRampProviderLogo } from "@/lib/ramps";
import { useSolanaCluster } from "@/lib/use-solana-cluster";

function TransferStatusBadge({ status }: { status: PaymentTransferSummary["status"] }) {
  const t = useTranslations();
  return <Badge variant={statusVariant(status)}>{t(statusMessageKey(status))}</Badge>;
}

function TransferProviderCell({ provider }: { provider: PersistedRampProviderId | undefined }) {
  if (provider === undefined) {
    return <span className="text-sm text-tertiary">—</span>;
  }
  const logo = getRampProviderLogo(provider);
  return (
    <div className="flex items-center gap-2">
      {logo === undefined ? null : (
        <Image src={logo} alt="" width={20} height={20} className="size-5 rounded" />
      )}
      <span className="text-sm text-primary">{getRampProviderLabel(provider)}</span>
    </div>
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
      {transfer.confirmedAt ? (
        <DetailRow
          label={t("DashboardPayments.ramps.completed")}
          value={formatTimestamp(transfer.confirmedAt, t)}
        />
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

export function TransferDetailModal({
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
  const locale = useLocale();
  const isInbound = isInboundTransfer(transfer);
  const signature = transfer.signature;
  const flow = resolveTransferFlow(transfer);
  const phase =
    transfer.type === "onramp" || transfer.type === "offramp"
      ? rampPhaseCopy(t, transfer, { locale })
      : null;

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
        {phase ? (
          <p
            className={cn(
              "text-sm leading-relaxed",
              phase.tone === "attention" ? "text-warning" : "text-secondary"
            )}
          >
            {phase.description}
          </p>
        ) : null}

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
