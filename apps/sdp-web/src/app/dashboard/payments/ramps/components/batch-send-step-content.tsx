"use client";

import type { PaymentTransferBatchRecipientStatus, PaymentTransferBatchStatus } from "@sdp/types";
import { ExternalLink, WalletIcon } from "lucide-react";
import { motion } from "motion/react";
import { useMemo, useState } from "react";
import {
  formatTokenAmount,
  shortenAddress,
} from "@/app/dashboard/payments/payments-overview.utils";
import { getDevnetExplorerUrl } from "@/app/dashboard/payments/payments-workspace.data";
import { Combobox } from "@/components/ui/combobox";
import { cn } from "@/lib/utils";
import type { BatchSendWizard } from "../hooks/use-batch-send-wizard";
import { walletComboboxOptions } from "../wallet-options";
import { AmountBalanceReadout } from "./amount-balance-readout";
import { BatchRecipientTable } from "./batch-recipient-table";
import { BulkImportDialog } from "./bulk-import-dialog";

const RECIPIENT_STATUS_TONE = {
  pending: "text-text-low",
  processing: "text-text-low",
  confirmed: "text-status-success-text",
  failed: "text-status-error-text",
  archived: "text-text-low",
} as const satisfies Record<PaymentTransferBatchRecipientStatus, string>;

function batchResultTitle(status: PaymentTransferBatchStatus): string {
  switch (status) {
    case "confirmed":
      return "Batch sent";
    case "partially_failed":
      return "Batch partially failed";
    case "failed":
      return "Batch failed";
    case "pending":
    case "processing":
    case "archived":
      return "Batch submitted";
    default: {
      const exhaustive: never = status;
      throw new Error(`Unhandled batch status: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function pluralRecipients(count: number): string {
  return `${count} recipient${count === 1 ? "" : "s"}`;
}

function rootLabelOf(wizard: BatchSendWizard): string {
  return wizard.selectedWallet?.label ?? wizard.selectedWallet?.walletId ?? "your wallet";
}

function RecipientsStep({ wizard }: { wizard: BatchSendWizard }) {
  const {
    liveWallets,
    walletsLoading,
    walletId,
    selectWallet,
    asset,
    displayAsset,
    setAsset,
    assetOptions,
    selectedAssetBalance,
    availableAmount,
    totalAmount,
    exceedsBalance,
    pageRecipients,
    recipientsLoading,
    recipientTotal,
    page,
    pageCount,
    setPage,
    search,
    setSearchQuery,
    recipients,
    entries,
    toggleRecipient,
    setManySelected,
    setRecipientAmount,
    bulkImport,
  } = wizard;

  const [bulkOpen, setBulkOpen] = useState(false);
  const walletOptions = useMemo(() => walletComboboxOptions(liveWallets), [liveWallets]);

  return (
    <div className="space-y-4">
      <div className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_140px]">
        <Combobox
          label="From"
          value={walletId || null}
          onChange={selectWallet}
          options={walletOptions}
          placeholder="Select a source wallet"
          searchPlaceholder="Search wallets"
          icon={<WalletIcon className="size-5 shrink-0 text-text-low" />}
          isLoading={walletsLoading}
          trailing={
            selectedAssetBalance ? (
              <motion.span
                className="inline-flex"
                animate={exceedsBalance ? { x: [0, -2, 2, -2, 2, 0] } : { x: 0 }}
                transition={{ duration: 0.4 }}
              >
                <AmountBalanceReadout
                  available={selectedAssetBalance.uiAmount}
                  assetLabel={displayAsset}
                  exceeds={exceedsBalance}
                />
              </motion.span>
            ) : null
          }
        />
        <Combobox
          label="Asset"
          value={asset || null}
          onChange={setAsset}
          options={assetOptions.map((value) => ({ value, label: value }))}
          placeholder="Select an asset"
          searchable={false}
        />
      </div>

      <div className="flex items-center justify-between gap-4 px-1">
        <p className="text-xl font-medium tracking-tight text-text-extra-high">
          Select recipient wallets
        </p>
        <button
          type="button"
          onClick={() => setBulkOpen(true)}
          className="text-sm font-medium text-text-low transition-colors hover:text-text-extra-high"
        >
          Or bulk import
        </button>
      </div>

      <BatchRecipientTable
        pageRecipients={pageRecipients}
        entries={entries}
        asset={asset}
        displayAsset={displayAsset}
        isLoading={recipientsLoading}
        page={page}
        pageCount={pageCount}
        total={recipientTotal}
        onPageChange={setPage}
        search={search}
        onSearchChange={setSearchQuery}
        onToggle={toggleRecipient}
        onToggleMany={setManySelected}
        onAmountChange={setRecipientAmount}
      />

      <BulkImportDialog open={bulkOpen} onClose={() => setBulkOpen(false)} onImport={bulkImport} />

      {recipients.length > 0 ? (
        <div className="flex items-center justify-between px-1 text-sm">
          <span className={exceedsBalance ? "font-medium text-status-error-text" : "text-text-low"}>
            {exceedsBalance ? "Insufficient balance" : pluralRecipients(recipients.length)}
          </span>
          <span
            className={cn(
              "font-medium",
              exceedsBalance ? "text-status-error-text" : "text-text-extra-high"
            )}
          >
            Total {formatTokenAmount(totalAmount)} {displayAsset}
            {availableAmount !== null
              ? ` of ${formatTokenAmount(availableAmount)} ${displayAsset}`
              : ""}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function BatchReviewView({ wizard }: { wizard: BatchSendWizard }) {
  const { recipients, displayAsset, totalAmount, estimate, estimateError } = wizard;
  const rootLabel = rootLabelOf(wizard);

  return (
    <div className="space-y-5">
      <section className="space-y-1 rounded-2xl bg-border-extra-light p-5 text-center">
        <p className="text-3xl font-semibold tracking-tight text-text-extra-high">
          {formatTokenAmount(totalAmount)} {displayAsset}
        </p>
        <p className="text-sm text-text-low">
          to {pluralRecipients(recipients.length)} from {rootLabel}
        </p>
        {estimateError ? (
          <p className="pt-1 text-sm text-status-error-text">{estimateError}</p>
        ) : estimate ? (
          <p className="pt-1 text-sm text-text-low">
            Sent as {estimate.transactionCount} transaction
            {estimate.transactionCount === 1 ? "" : "s"} ·{" "}
            {estimate.estimatedFees.sponsored ? "Network fee sponsored" : "Network fee applies"}
          </p>
        ) : (
          <p className="pt-1 text-sm text-text-low">Estimating…</p>
        )}
      </section>
      <div className="flex flex-col gap-0.5">
        {recipients.map((recipient) => (
          <div
            key={recipient.counterpartyAccountId}
            className="flex items-center justify-between gap-3 px-3 py-2.5"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-text-extra-high">
                {recipient.label && recipient.label.trim().length > 0
                  ? recipient.label
                  : recipient.name}
              </p>
              <p className="flex items-center gap-1.5 truncate text-xs text-text-low">
                {recipient.label && recipient.label.trim().length > 0 ? (
                  <span>{recipient.name}</span>
                ) : null}
                <span className="font-mono">{shortenAddress(recipient.address)}</span>
              </p>
            </div>
            <span className="shrink-0 text-sm font-medium text-text-extra-high">
              {formatTokenAmount(recipient.amount)} {displayAsset}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function BatchResultView({ wizard }: { wizard: BatchSendWizard }) {
  const { batchResult, recipients, displayAsset } = wizard;
  const nameByAccount = useMemo(
    () => new Map(recipients.map((r) => [r.counterpartyAccountId, r.name])),
    [recipients]
  );
  if (!batchResult) {
    return null;
  }
  const signatureByTransfer = new Map(
    batchResult.transfers.map((transfer) => [transfer.id, transfer.signature])
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-col items-center gap-1 pb-1 text-center">
        <p className="text-2xl font-medium tracking-tight text-text-extra-high">
          {batchResultTitle(batchResult.batch.status)}
        </p>
        <p className="text-sm text-text-low">
          {batchResult.batch.recipientCount} recipients · {batchResult.batch.transactionCount}{" "}
          transactions
        </p>
      </div>
      <div className="flex flex-col gap-0.5">
        {batchResult.recipients.map((recipient) => {
          const signature = recipient.transferId
            ? signatureByTransfer.get(recipient.transferId)
            : null;
          const name = nameByAccount.get(recipient.counterpartyAccountId);
          return (
            <div key={recipient.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
              <div className="min-w-0">
                {name ? (
                  <p className="truncate text-sm font-medium text-text-extra-high">{name}</p>
                ) : null}
                <p className="truncate font-mono text-xs text-text-low">
                  {formatTokenAmount(recipient.amount)} {displayAsset} ·{" "}
                  {shortenAddress(recipient.destination)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span
                  className={cn("text-sm font-medium", RECIPIENT_STATUS_TONE[recipient.status])}
                >
                  {recipient.status}
                </span>
                {signature ? (
                  <button
                    type="button"
                    onClick={() => window.open(getDevnetExplorerUrl(signature), "_blank")}
                    className="text-text-low hover:text-text-extra-high"
                    aria-label="View on explorer"
                  >
                    <ExternalLink className="size-4" />
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function BatchSendStepContent({ wizard }: { wizard: BatchSendWizard }) {
  if (wizard.currentStepId === "RECIPIENTS") {
    return <RecipientsStep wizard={wizard} />;
  }
  if (wizard.batchResult) {
    return <BatchResultView wizard={wizard} />;
  }
  return <BatchReviewView wizard={wizard} />;
}
