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
import { Label } from "@/components/ui/label";
import { SkeletonBlock } from "@/components/ui/skeleton-block";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import type { BatchSendWizard } from "../hooks/use-batch-send-wizard";
import { MAX_BATCH_RECIPIENTS } from "../schema";
import { walletComboboxOptions } from "../wallet-options";
import { AmountBalanceReadout } from "./amount-balance-readout";
import { BulkImportDialog } from "./bulk-import-dialog";

const RECIPIENT_STATUS_TONE = {
  pending: "text-tertiary",
  processing: "text-tertiary",
  confirmed: "text-success",
  failed: "text-error",
  archived: "text-tertiary",
} as const satisfies Record<PaymentTransferBatchRecipientStatus, string>;

type Translate = ReturnType<typeof useTranslations>;

function recipientStatusLabel(status: PaymentTransferBatchRecipientStatus, t: Translate): string {
  switch (status) {
    case "pending":
      return t("DashboardPayments.batchSend.recipientStatusPending");
    case "processing":
      return t("DashboardPayments.batchSend.recipientStatusProcessing");
    case "confirmed":
      return t("DashboardPayments.batchSend.recipientStatusConfirmed");
    case "failed":
      return t("DashboardPayments.batchSend.recipientStatusFailed");
    case "archived":
      return t("DashboardPayments.batchSend.recipientStatusArchived");
  }
}

function batchResultTitle(status: PaymentTransferBatchStatus, t: Translate): string {
  switch (status) {
    case "confirmed":
      return t("DashboardPayments.batchSend.resultConfirmed");
    case "partially_failed":
      return t("DashboardPayments.batchSend.resultPartiallyFailed");
    case "failed":
      return t("DashboardPayments.batchSend.resultFailed");
    case "pending":
    case "processing":
    case "archived":
      return t("DashboardPayments.batchSend.resultSubmitted");
    default: {
      const exhaustive: never = status;
      throw new Error(`Unhandled batch status: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function pluralRecipients(count: number, t: Translate): string {
  return t(
    count === 1
      ? "DashboardPayments.batchSend.recipientSingular"
      : "DashboardPayments.batchSend.recipientPlural",
    { count }
  );
}

function rootLabelOf(wizard: BatchSendWizard, t: Translate): string {
  return (
    wizard.selectedWallet?.label ??
    wizard.selectedWallet?.walletId ??
    t("DashboardPayments.batchSend.yourWallet")
  );
}

function recipientsStatusLabel(
  count: number,
  exceedsBalance: boolean,
  exceedsMax: boolean,
  t: Translate
): string {
  if (exceedsMax) {
    return t("DashboardPayments.batchSend.maximumRecipients", { count: MAX_BATCH_RECIPIENTS });
  }
  if (exceedsBalance) {
    return t("DashboardPayments.batchSend.insufficientBalance");
  }
  return t(
    count === 1
      ? "DashboardPayments.batchSend.walletsSelectedSingular"
      : "DashboardPayments.batchSend.walletsSelectedPlural",
    { count }
  );
}

function RecipientsStep({ wizard }: { wizard: BatchSendWizard }) {
  const t = useTranslations();
  const {
    liveWallets,
    walletsLoading,
    walletId,
    selectWallet,
    asset,
    displayAsset,
    setAsset,
    externalId,
    setExternalId,
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
      <div className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_200px]">
        <Combobox
          label={t("DashboardPayments.batchSend.from")}
          value={walletId || null}
          onChange={selectWallet}
          options={walletOptions}
          placeholder={t("DashboardPayments.batchSend.selectSourceWallet")}
          searchPlaceholder={t("DashboardPayments.batchSend.searchWallets")}
          icon={<WalletIcon className="size-5 shrink-0 text-tertiary" />}
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
          label={t("DashboardPayments.batchSend.asset")}
          value={asset || null}
          onChange={setAsset}
          options={assetOptions}
          placeholder={t("DashboardPayments.batchSend.selectAsset")}
          searchable={false}
          disabled={!walletId || assetOptions.length === 0}
        />
        <div className="flex flex-col gap-2 sm:col-span-2">
          <Label htmlFor="batch-send-reference">{t("DashboardPayments.batchSend.reference")}</Label>
          <Input
            id="batch-send-reference"
            value={externalId}
            onChange={(event) => setExternalId(event.currentTarget.value)}
            maxLength={256}
            placeholder={t("DashboardPayments.batchSend.referenceOptional")}
            size="xl"
          />
        </div>
      </div>

      {walletId && assetOptions.length === 0 ? (
        <p className="text-sm text-error">{t("DashboardPayments.batchSend.noAssets")}</p>
      ) : null}

      <div className="flex items-center justify-between gap-4 px-1">
        <p className="text-xl font-medium tracking-tight text-primary">
          {t("DashboardPayments.batchSend.selectRecipientWallets")}
        </p>
        <button
          type="button"
          onClick={() => setBulkOpen(true)}
          className="text-sm font-medium text-tertiary transition-colors hover:text-primary"
        >
          {t("DashboardPayments.batchSend.bulkImport")}
        </button>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <div className="relative flex-1">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3.5 size-5 -translate-y-1/2 text-tertiary" />
            <Input
              value={search}
              onChange={(event) => setSearchQuery(event.currentTarget.value)}
              placeholder={t("DashboardPayments.batchSend.searchCounterparty")}
              size="xl"
              className="h-[var(--input-height-xl)] pl-11 [&>span:first-child]:h-[var(--input-height-xl)] [&>span:first-child]:bg-[var(--input-bg-idle)]"
            />
          </div>
          <ArrowPagination
            page={page}
            pageCount={pageCount}
            onPageChange={setPage}
            summary={t("DashboardPayments.batchSend.paginationSummary", { page, pageCount })}
            className="shrink-0 gap-2"
          />
        </div>

        <motion.div
          key={page}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.15 }}
          className="divide-y divide-border-default"
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
            <p className="py-6 text-center text-sm text-tertiary">
              {recipientTotal === 0
                ? t("DashboardPayments.batchSend.noCounterpartiesWithSolanaAddress")
                : t("DashboardPayments.batchSend.noMatches")}
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
                    isSelected ? "bg-fill-subtle" : "hover:bg-fill-subtle"
                  )}
                >
                  <button
                    type="button"
                    onClick={() => toggleRecipient(account)}
                    className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
                  >
                    <span className="truncate text-sm font-medium text-primary">
                      {account.name}
                    </span>
                    <span className="truncate text-xs text-tertiary">
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
                        className="w-24 border-0 border-b border-border-strong bg-transparent pb-0.5 text-right text-sm text-primary [appearance:textfield] focus:border-[var(--input-border-focus)] focus:outline-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                      />
                      <span className="text-sm text-tertiary">{displayAsset}</span>
                    </motion.div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => toggleRecipient(account)}
                      aria-label={t("DashboardPayments.batchSend.addRecipient", {
                        name: account.name,
                      })}
                      className="shrink-0 text-tertiary transition-colors hover:text-primary"
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
              exceedsBalance || exceedsMaxRecipients ? "font-medium text-error" : "text-tertiary"
            }
          >
            {recipientsStatusLabel(recipients.length, exceedsBalance, exceedsMaxRecipients, t)}
          </span>
          <span className={cn("font-medium", exceedsBalance ? "text-error" : "text-primary")}>
            {t("DashboardPayments.batchSend.totalAmount", {
              total: formatTokenAmount(totalAmount),
              asset: displayAsset,
            })}
            {availableAmount !== null
              ? t("DashboardPayments.batchSend.totalOfAmount", {
                  available: formatTokenAmount(availableAmount),
                  asset: displayAsset,
                })
              : ""}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function BatchReviewView({ wizard }: { wizard: BatchSendWizard }) {
  const t = useTranslations();
  const { recipients, displayAsset, totalAmount, estimate, estimateError } = wizard;
  const rootLabel = rootLabelOf(wizard, t);
  const fees = estimate?.estimatedFees;
  const totalFeeLamports = fees
    ? BigInt(fees.networkFeeLamports) +
      BigInt(fees.priorityFeeLamports) +
      BigInt(fees.tokenAccountRentLamports)
    : null;

  return (
    <div className="space-y-5">
      <section className="space-y-4 rounded-2xl bg-fill-subtle p-5">
        <div className="space-y-0.5 text-center">
          <p className="text-3xl font-semibold tracking-tight text-primary">
            {t("DashboardPayments.batchSend.reviewSummary", {
              total: formatTokenAmount(totalAmount),
              asset: displayAsset,
              recipients: pluralRecipients(recipients.length, t),
            })}
          </p>
          {estimate ? (
            <p className="text-sm text-tertiary">
              {t(
                estimate.transactionCount === 1
                  ? "DashboardPayments.batchSend.transactionCountSingular"
                  : "DashboardPayments.batchSend.transactionCountPlural",
                { count: estimate.transactionCount }
              )}
            </p>
          ) : null}
        </div>
        {estimateError ? (
          <p className="text-center text-sm text-error">{estimateError}</p>
        ) : fees && totalFeeLamports !== null ? (
          <dl className="space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <dt className="text-tertiary">{t("DashboardPayments.batchSend.source")}</dt>
              <dd className="text-primary">{rootLabel}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-tertiary">{t("DashboardPayments.batchSend.transactionFees")}</dt>
              <dd className="text-primary">
                {formatLamportsAsSol(
                  BigInt(fees.networkFeeLamports) + BigInt(fees.priorityFeeLamports)
                )}
              </dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-tertiary">{t("DashboardPayments.batchSend.rentFees")}</dt>
              <dd className="text-primary">
                {formatLamportsAsSol(BigInt(fees.tokenAccountRentLamports))}
              </dd>
            </div>
            <div className="h-px bg-fill-strong" />
            <div className="flex items-center justify-between">
              <span className="font-medium text-primary">
                {t("DashboardPayments.batchSend.total")}
              </span>
              <span className="flex items-center gap-2">
                {fees.sponsored ? (
                  <>
                    <span className="text-tertiary line-through">
                      {formatLamportsAsSol(totalFeeLamports)}
                    </span>
                    <span className="font-medium text-primary">
                      {t("DashboardPayments.batchSend.sponsoredFee")}
                    </span>
                    <span className="rounded-full bg-surface-raised px-2 py-0.5 text-xs font-medium text-secondary">
                      {t("DashboardPayments.batchSend.sponsoredBy")}
                    </span>
                  </>
                ) : (
                  <span className="font-medium text-primary">
                    {formatLamportsAsSol(totalFeeLamports)}
                  </span>
                )}
              </span>
            </div>
          </dl>
        ) : (
          <p className="text-center text-sm text-tertiary">
            {t("DashboardPayments.batchSend.estimating")}
          </p>
        )}
      </section>
      <div className="flex flex-col gap-0.5">
        {recipients.map((recipient) => (
          <div
            key={recipient.counterpartyAccountId}
            className="flex items-center justify-between gap-3 px-3 py-2.5"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-primary">
                {recipient.label && recipient.label.trim().length > 0
                  ? recipient.label
                  : recipient.name}
              </p>
              <p className="flex items-center gap-1.5 truncate text-xs text-tertiary">
                {recipient.label && recipient.label.trim().length > 0 ? (
                  <span>{recipient.name}</span>
                ) : null}
                <span className="font-mono">{shortenAddress(recipient.address)}</span>
              </p>
            </div>
            <span className="shrink-0 text-sm font-medium text-primary">
              {formatTokenAmount(recipient.amount)} {displayAsset}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function BatchResultView({ wizard }: { wizard: BatchSendWizard }) {
  const t = useTranslations();
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
        <p className="text-2xl font-medium tracking-tight text-primary">
          {batchResultTitle(batchResult.batch.status, t)}
        </p>
        <p className="text-sm text-tertiary">
          {t("DashboardPayments.batchSend.resultSummary", {
            recipients: batchResult.batch.recipientCount,
            transactions: batchResult.batch.transactionCount,
          })}
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
                {name ? <p className="truncate text-sm font-medium text-primary">{name}</p> : null}
                <p className="truncate font-mono text-xs text-tertiary">
                  {formatTokenAmount(recipient.amount)} {displayAsset} ·{" "}
                  {shortenAddress(recipient.destination)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span
                  className={cn("text-sm font-medium", RECIPIENT_STATUS_TONE[recipient.status])}
                >
                  {recipientStatusLabel(recipient.status, t)}
                </span>
                {signature ? (
                  <button
                    type="button"
                    onClick={() => window.open(getDevnetExplorerUrl(signature), "_blank")}
                    className="text-tertiary hover:text-primary"
                    aria-label={t("DashboardPayments.batchSend.viewOnExplorer")}
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
