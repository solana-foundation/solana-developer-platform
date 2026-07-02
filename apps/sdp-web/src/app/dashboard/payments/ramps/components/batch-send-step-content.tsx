"use client";

import type { PaymentTransferBatchRecipientStatus, PaymentTransferBatchStatus } from "@sdp/types";
import { ExternalLink, PlusIcon, SearchIcon, WalletIcon } from "lucide-react";
import { motion } from "motion/react";
import { useMemo, useState } from "react";
import {
  formatLamportsAsSol,
  formatTokenAmount,
  shortenAddress,
} from "@/app/dashboard/payments/payments-overview.utils";
import { getDevnetExplorerUrl } from "@/app/dashboard/payments/payments-workspace.data";
import { ArrowPagination } from "@/components/ui/arrow-pagination";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { SkeletonBlock } from "@/components/ui/skeleton-block";
import { cn } from "@/lib/utils";
import type { BatchSendWizard } from "../hooks/use-batch-send-wizard";
import { MAX_BATCH_RECIPIENTS } from "../schema";
import { walletComboboxOptions } from "../wallet-options";
import { AmountBalanceReadout } from "./amount-balance-readout";
import { BulkImportDialog } from "./bulk-import-dialog";

const RECIPIENT_STATUS_TONE = {
  pending: "text-text-low",
  processing: "text-text-low",
  confirmed: "text-status-success-text",
  failed: "text-status-error-text",
  archived: "text-text-low",
} as const satisfies Record<PaymentTransferBatchRecipientStatus, string>;

const RECIPIENT_STATUS_LABEL = {
  pending: "Pending",
  processing: "Processing",
  confirmed: "Complete",
  failed: "Failed",
  archived: "Archived",
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

function recipientsStatusLabel(
  count: number,
  exceedsBalance: boolean,
  exceedsMax: boolean
): string {
  if (exceedsMax) {
    return `A batch can have at most ${MAX_BATCH_RECIPIENTS} recipients.`;
  }
  if (exceedsBalance) {
    return "Insufficient balance";
  }
  return `${count} wallet${count === 1 ? "" : "s"} selected`;
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
    exceedsMaxRecipients,
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
          options={assetOptions}
          placeholder="Select an asset"
          searchable={false}
          disabled={!walletId || assetOptions.length === 0}
        />
      </div>

      {walletId && assetOptions.length === 0 ? (
        <p className="text-sm text-status-error-text">
          This wallet has no assets available to send.
        </p>
      ) : null}

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

      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <div className="relative flex-1">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3.5 size-5 -translate-y-1/2 text-text-low" />
            <Input
              value={search}
              onChange={(event) => setSearchQuery(event.currentTarget.value)}
              placeholder="Search counterparty"
              size="xl"
              className="h-[var(--input-height-xl)] pl-11 [&>span:first-child]:h-[var(--input-height-xl)] [&>span:first-child]:bg-[var(--input-bg-idle)]"
            />
          </div>
          <ArrowPagination
            page={page}
            pageCount={pageCount}
            onPageChange={setPage}
            summary={`${page} / ${pageCount}`}
            className="shrink-0 gap-2"
          />
        </div>

        <motion.div
          key={page}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.15 }}
          className="divide-y divide-border-light"
        >
          {recipientsLoading ? (
            Array.from({ length: 6 }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
              <div key={i} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <div className="flex min-w-0 flex-1 flex-col gap-2.5">
                  <SkeletonBlock className="h-4 w-32" />
                  <SkeletonBlock className="h-3 w-44" />
                </div>
                <SkeletonBlock className="size-4 shrink-0 rounded" />
              </div>
            ))
          ) : pageRecipients.length === 0 ? (
            <p className="py-6 text-center text-sm text-text-low">
              {recipientTotal === 0 ? "No counterparties with a Solana address." : "No matches."}
            </p>
          ) : (
            pageRecipients.map((account) => {
              const entry = entries[account.counterpartyAccountId];
              const isSelected = Boolean(entry);
              const hasLabel = account.label !== null && account.label.trim().length > 0;
              return (
                <div
                  key={account.counterpartyAccountId}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2.5 transition-colors",
                    isSelected ? "bg-border-extra-light" : "hover:bg-border-extra-light"
                  )}
                >
                  <button
                    type="button"
                    onClick={() => toggleRecipient(account)}
                    className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
                  >
                    <span className="truncate text-sm font-medium text-text-extra-high">
                      {account.name}
                    </span>
                    <span className="truncate text-xs text-text-low">
                      {hasLabel ? `${account.label} · ` : ""}
                      <span className="font-mono">{shortenAddress(account.address)}</span>
                    </span>
                  </button>
                  {isSelected ? (
                    <motion.div
                      initial={{ opacity: 0, x: 8 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ duration: 0.15 }}
                      className="flex shrink-0 items-center gap-1.5"
                    >
                      <input
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="any"
                        value={entry.amount}
                        onChange={(event) => setRecipientAmount(account, event.currentTarget.value)}
                        onBlur={() => {
                          if (entry.amount.trim() === "" || Number(entry.amount) === 0) {
                            toggleRecipient(account);
                          }
                        }}
                        placeholder="0.0"
                        className="w-24 border-0 border-b border-border-medium bg-transparent pb-0.5 text-right text-sm text-text-extra-high [appearance:textfield] focus:border-[var(--input-border-focus)] focus:outline-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                      />
                      <span className="text-sm text-text-low">{displayAsset}</span>
                    </motion.div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => toggleRecipient(account)}
                      aria-label={`Add ${account.name}`}
                      className="shrink-0 text-text-low transition-colors hover:text-text-extra-high"
                    >
                      <PlusIcon className="size-4" />
                    </button>
                  )}
                </div>
              );
            })
          )}
        </motion.div>
      </div>

      <BulkImportDialog open={bulkOpen} onClose={() => setBulkOpen(false)} onImport={bulkImport} />

      {recipients.length > 0 ? (
        <div className="flex items-center justify-between px-1 text-sm">
          <span
            className={
              exceedsBalance || exceedsMaxRecipients
                ? "font-medium text-status-error-text"
                : "text-text-low"
            }
          >
            {recipientsStatusLabel(recipients.length, exceedsBalance, exceedsMaxRecipients)}
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
  const fees = estimate?.estimatedFees;
  const totalFeeLamports = fees
    ? BigInt(fees.networkFeeLamports) +
      BigInt(fees.priorityFeeLamports) +
      BigInt(fees.tokenAccountRentLamports)
    : null;

  return (
    <div className="space-y-5">
      <section className="space-y-4 rounded-2xl bg-border-extra-light p-5">
        <div className="space-y-0.5 text-center">
          <p className="text-3xl font-semibold tracking-tight text-text-extra-high">
            {formatTokenAmount(totalAmount)} {displayAsset} → {pluralRecipients(recipients.length)}
          </p>
          {estimate ? (
            <p className="text-sm text-text-low">
              {estimate.transactionCount} transaction
              {estimate.transactionCount === 1 ? "" : "s"}
            </p>
          ) : null}
        </div>
        {estimateError ? (
          <p className="text-center text-sm text-status-error-text">{estimateError}</p>
        ) : fees && totalFeeLamports !== null ? (
          <dl className="space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <dt className="text-text-low">Source</dt>
              <dd className="text-text-high">{rootLabel}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-text-low">Transaction fees</dt>
              <dd className="text-text-high">
                {formatLamportsAsSol(
                  BigInt(fees.networkFeeLamports) + BigInt(fees.priorityFeeLamports)
                )}
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-text-low">Rent fees</dt>
              <dd className="text-text-high">
                {formatLamportsAsSol(BigInt(fees.tokenAccountRentLamports))}
              </dd>
            </div>
            <div className="h-px bg-border-light" />
            <div className="flex items-center justify-between">
              <span className="font-medium text-text-extra-high">Total</span>
              <span className="flex items-center gap-2">
                {fees.sponsored ? (
                  <>
                    <span className="text-text-low line-through">
                      {formatLamportsAsSol(totalFeeLamports)}
                    </span>
                    <span className="font-medium text-text-extra-high">0 SOL</span>
                    <span className="rounded-full bg-white px-2 py-0.5 text-xs font-medium text-text-medium">
                      Sponsored by SDP via Kora
                    </span>
                  </>
                ) : (
                  <span className="font-medium text-text-extra-high">
                    {formatLamportsAsSol(totalFeeLamports)}
                  </span>
                )}
              </span>
            </div>
          </dl>
        ) : (
          <p className="text-center text-sm text-text-low">Estimating…</p>
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
                  {RECIPIENT_STATUS_LABEL[recipient.status]}
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
