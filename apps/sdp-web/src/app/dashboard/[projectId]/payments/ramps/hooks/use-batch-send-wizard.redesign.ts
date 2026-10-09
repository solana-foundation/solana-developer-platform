"use client";

import {
  type CounterpartyAccountSummary,
  type CustodyWalletTokenBalance,
  isWellKnownTokenSymbol,
  type PaymentsDashboardWallet,
  type SolanaCluster,
  WELL_KNOWN_TOKEN_BY_MINT,
  wellKnownMint,
} from "@sdp/types";
import {
  addDecimalFixedPoint,
  decimalFixedPoint,
  decimalFixedPointToString,
} from "@solana/fixed-points";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import { shortenAddress } from "@/app/dashboard/[projectId]/payments/payments-overview.utils";
import { paymentsQueryKeys } from "@/app/dashboard/[projectId]/payments/payments-query-key";
import {
  type CreateTransferBatchResult,
  createTransferBatch,
  estimateTransferBatch,
  fetchBatchRecipients,
  TransferBatchRequestError,
} from "@/app/dashboard/[projectId]/payments/payments-workspace.data";
import {
  canonicalTransferBatchRequest,
  claimTransferBatchIdempotencyKey,
  holdTransferBatchIdempotencyKey,
  isTransferBatchKeyConflict,
  releaseTransferBatchIdempotencyKey,
  transferBatchRequestFingerprint,
} from "@/app/dashboard/[projectId]/payments/transfer-batch-idempotency";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { useProjectHref } from "@/lib/use-dashboard-project";
import type { BulkImportRow } from "../bulk-import.redesign";
import { batchSendSchema, MAX_BATCH_RECIPIENTS, ONCHAIN_AMOUNT_PATTERN } from "../schema";
import { walletBalanceAssetOptions } from "../wallet-options";
import { usePaymentsActionWallets } from "./use-payments-action-wallets";
import type { RampWizardStep } from "./use-ramp-wizard.redesign";

type Translate = (key: MessageKey, values?: TranslationValues) => string;
export type BatchSendStepId = "RECIPIENTS" | "REVIEW";

export function getBatchSendSteps(t: Translate): readonly RampWizardStep<BatchSendStepId>[] {
  return [
    // The rows form speaks for itself; the step header already says "Details".
    { id: "RECIPIENTS", label: t("DashboardPayments.onchainSend.details"), title: "" },
    {
      id: "REVIEW",
      label: t("DashboardPayments.batchSend.reviewStep"),
      title: t("DashboardPayments.batchSend.reviewTitle"),
    },
  ];
}

export type BatchEligibleRecipient = CounterpartyAccountSummary;

const RECIPIENTS_PAGE_SIZE = 6;

/** u64 with 9 decimals — matches ONCHAIN_AMOUNT_PATTERN's max fractional digits. */
const batchAmountFixedPoint = decimalFixedPoint("unsigned", 64, 9);

/** Sums schema-valid amounts exactly, skipping entries still being typed. */
export function sumBatchAmounts(amounts: string[]): string {
  return decimalFixedPointToString(
    amounts.reduce((sum, amount) => {
      const trimmed = amount.trim();
      return ONCHAIN_AMOUNT_PATTERN.test(trimmed)
        ? addDecimalFixedPoint(sum, batchAmountFixedPoint(trimmed))
        : sum;
    }, batchAmountFixedPoint("0"))
  );
}

export interface BatchRecipientDraft {
  counterpartyId: string;
  counterpartyAccountId: string;
  name: string;
  address: string;
  label: string | null;
  amount: string;
}

export interface BatchRecipientEntry {
  recipient: BatchEligibleRecipient;
  amount: string;
}

export interface UseBatchSendWizardProps {
  wallets: PaymentsDashboardWallet[];
  walletsError: string | null;
  issuedTokenSymbolsByMint: Record<string, string>;
  cluster: SolanaCluster;
  onExit: () => void;
}

/**
 * One page of the contacts a batch can pay, filtered by the search box. A new search starts
 * again from the first page.
 */
function useBatchRecipientPage() {
  const t = useTranslations();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");

  const trimmedSearch = search.trim();
  const { data: recipientPage, isLoading: recipientsLoading } = useSWR(
    paymentsQueryKeys.batchRecipients({ page, search: trimmedSearch }),
    () =>
      fetchBatchRecipients(
        {
          page,
          pageSize: RECIPIENTS_PAGE_SIZE,
          search: trimmedSearch.length > 0 ? trimmedSearch : undefined,
        },
        t
      ),
    { revalidateOnFocus: false, keepPreviousData: true }
  );
  const pageRecipients = recipientPage ? recipientPage.accounts : [];
  const recipientTotal = recipientPage ? recipientPage.total : 0;
  const pageCount = Math.max(1, Math.ceil(recipientTotal / RECIPIENTS_PAGE_SIZE));

  const setSearchQuery = (next: string) => {
    setSearch(next);
    setPage(1);
  };

  return {
    page,
    setPage,
    search,
    setSearchQuery,
    pageRecipients,
    recipientsLoading,
    recipientTotal,
    pageCount,
  };
}

/**
 * The rows in the batch, keyed by counterparty account so a pick survives paging and
 * searching, with the ways to add, remove, and price them.
 */
function useBatchRecipientEntries() {
  const [entries, setEntries] = useState<Record<string, BatchRecipientEntry>>({});

  // Typing an amount also adds the row to the batch, so the input can show on every row.
  const setRecipientAmount = (recipient: BatchEligibleRecipient, amount: string) => {
    setEntries((prev) => ({
      ...prev,
      [recipient.counterpartyAccountId]: { recipient, amount },
    }));
  };

  const toggleRecipient = (recipient: BatchEligibleRecipient) => {
    setEntries((prev) => {
      const next = { ...prev };
      if (next[recipient.counterpartyAccountId]) {
        delete next[recipient.counterpartyAccountId];
      } else {
        next[recipient.counterpartyAccountId] = { recipient, amount: "" };
      }
      return next;
    });
  };

  const setManySelected = (recipientsToSet: BatchEligibleRecipient[], value: boolean) => {
    setEntries((prev) => {
      const next = { ...prev };
      for (const recipient of recipientsToSet) {
        if (value) {
          if (!next[recipient.counterpartyAccountId]) {
            next[recipient.counterpartyAccountId] = { recipient, amount: "" };
          }
        } else {
          delete next[recipient.counterpartyAccountId];
        }
      }
      return next;
    });
  };

  return { entries, setEntries, setRecipientAmount, toggleRecipient, setManySelected };
}

/**
 * What the source wallet holds of the chosen token (0 when it holds none, null before a
 * wallet is picked), and whether the batch total is more than that.
 */
function batchBalanceCheck(
  selectedWallet: PaymentsDashboardWallet | null,
  selectedAssetBalance: CustodyWalletTokenBalance | null,
  totalAmount: string
): { availableAmount: number | null; exceedsBalance: boolean } {
  const totalAmountValue = Number(totalAmount);
  let availableAmount: number | null = null;
  if (selectedWallet) {
    availableAmount = selectedAssetBalance ? Number(selectedAssetBalance.uiAmount) : 0;
  }
  const exceedsBalance =
    totalAmountValue > 0 && availableAmount !== null && totalAmountValue > availableAmount;
  return { availableAmount, exceedsBalance };
}

/**
 * Whether the primary button may act. A finished batch always may; otherwise the wallet has
 * to be able to sign, and on the rows step the rows have to be valid, affordable, and in a
 * token the wallet holds.
 */
function batchCanProceed({
  batchResult,
  selectedWallet,
  currentStepId,
  recipientsValid,
  exceedsBalance,
  hasMint,
}: {
  batchResult: CreateTransferBatchResult | null;
  selectedWallet: PaymentsDashboardWallet | null;
  currentStepId: BatchSendStepId;
  recipientsValid: boolean;
  exceedsBalance: boolean;
  hasMint: boolean;
}): boolean {
  return (
    batchResult !== null ||
    (selectedWallet?.isRuntimeExecutionAllowed === true &&
      (currentStepId === "RECIPIENTS" ? recipientsValid && !exceedsBalance && hasMint : true))
  );
}

/** The fee estimate's failure as a sentence, or null while it has not failed. */
function estimateErrorMessage(error: unknown, t: Translate): string | null {
  if (!error) {
    return null;
  }
  return error instanceof Error ? error.message : t("DashboardPayments.batchSend.estimateFailed");
}

export function useBatchSendWizard({
  wallets,
  walletsError,
  issuedTokenSymbolsByMint,
  cluster,
  onExit,
}: UseBatchSendWizardProps) {
  const router = useRouter();
  const href = useProjectHref();
  const t = useTranslations();
  const steps = getBatchSendSteps(t);
  const [stepIndex, setStepIndex] = useState(0);
  const [walletId, setWalletId] = useState("");
  const [asset, setAsset] = useState("");
  const [externalId, setExternalId] = useState("");
  const { entries, setEntries, setRecipientAmount, toggleRecipient, setManySelected } =
    useBatchRecipientEntries();
  const [submitting, setSubmitting] = useState(false);
  const [batchResult, setBatchResult] = useState<CreateTransferBatchResult | null>(null);

  const { liveWallets, walletsLoading, liveWalletsError } = usePaymentsActionWallets(
    wallets,
    walletsError
  );

  const {
    page,
    setPage,
    search,
    setSearchQuery,
    pageRecipients,
    recipientsLoading,
    recipientTotal,
    pageCount,
  } = useBatchRecipientPage();

  const selectedWallet = useMemo(
    () => liveWallets.find((wallet) => wallet.id === walletId) ?? null,
    [liveWallets, walletId]
  );
  const signingUnavailable = !!walletId && selectedWallet?.isRuntimeExecutionAllowed !== true;
  const assetOptions = useMemo(
    () =>
      walletBalanceAssetOptions(selectedWallet, issuedTokenSymbolsByMint, t).map((option) => {
        const known =
          WELL_KNOWN_TOKEN_BY_MINT.has(option.value) ||
          Boolean(issuedTokenSymbolsByMint[option.value]);
        return {
          value: option.value,
          label: option.label === option.value ? shortenAddress(option.value) : option.label,
          description: known ? undefined : t("DashboardPayments.batchSend.unknownToken"),
        };
      }),
    [issuedTokenSymbolsByMint, selectedWallet, t]
  );
  const selectedAssetBalance = useMemo(
    () => selectedWallet?.balances?.find((balance) => balance.mint === asset) ?? null,
    [selectedWallet, asset]
  );
  const selectedAssetOption = assetOptions.find((option) => option.value === asset);
  const displayAsset: string | null =
    selectedAssetOption === undefined ? null : selectedAssetOption.label;

  const selectWallet = (nextWalletId: string) => {
    setWalletId(nextWalletId);
    const nextWallet = liveWallets.find((wallet) => wallet.id === nextWalletId) ?? null;
    const nextAssets = walletBalanceAssetOptions(nextWallet, issuedTokenSymbolsByMint, t);
    if (!nextAssets.some((option) => option.value === asset)) {
      const preferred = nextAssets.find((option) => option.label === "USDC");
      const fallback = preferred === undefined ? nextAssets[0] : preferred;
      setAsset(fallback === undefined ? "" : fallback.value);
    }
  };

  const bulkImport = async (rows: BulkImportRow[]): Promise<{ unresolved: string[] }> => {
    // One batch pays one token, and both importers (the paste dialog and the CSV drop) arrive
    // here. Rows are compared by the mint they resolve to, so "USDC" and USDC's mint address
    // name the same token; the check runs before any recipient is looked up.
    const mints = new Set<string>();
    for (const { currency } of rows) {
      const rowMint = isWellKnownTokenSymbol(currency)
        ? wellKnownMint(currency, cluster)
        : currency;
      if (!rowMint) {
        throw new Error(t("DashboardPayments.batchSend.tokenUnavailableOnNetwork", { currency }));
      }
      mints.add(rowMint);
    }
    if (mints.size > 1) {
      const currencies = [...new Set(rows.map((row) => row.currency))];
      throw new Error(
        t("DashboardPayments.batchSend.oneCurrencyRequired", { currencies: currencies.join(", ") })
      );
    }
    const [mint] = mints;

    const ids = [...new Set(rows.map((row) => row.accountId))];
    const resolved = await fetchBatchRecipients({ ids }, t);
    const byId = new Map(
      resolved.accounts.map((recipient) => [recipient.counterpartyAccountId, recipient])
    );
    const additions: Record<string, BatchRecipientEntry> = {};
    const unresolved: string[] = [];
    for (const row of rows) {
      const recipient = byId.get(row.accountId);
      if (recipient) {
        additions[row.accountId] = { recipient, amount: row.amount };
      } else {
        unresolved.push(row.accountId);
      }
    }
    if (unresolved.length > 0) {
      return { unresolved };
    }

    const nextEntries = mint === asset ? { ...entries, ...additions } : additions;
    if (Object.keys(nextEntries).length > MAX_BATCH_RECIPIENTS) {
      throw new Error(
        t("DashboardPayments.batchSend.importExceedsMaximumRecipients", {
          max: MAX_BATCH_RECIPIENTS,
          total: Object.keys(nextEntries).length,
        })
      );
    }
    setAsset(mint);
    setEntries(nextEntries);
    return { unresolved };
  };

  // The batch is whatever has an entry — selection persists across pages via the stored map.
  const recipients = useMemo<BatchRecipientDraft[]>(
    () =>
      Object.values(entries).map(({ recipient, amount }) => ({
        counterpartyId: recipient.counterpartyId,
        counterpartyAccountId: recipient.counterpartyAccountId,
        name: recipient.name,
        address: recipient.address,
        label: recipient.label,
        amount,
      })),
    [entries]
  );

  const totalAmount = useMemo(() => sumBatchAmounts(recipients.map((r) => r.amount)), [recipients]);
  const { availableAmount, exceedsBalance } = batchBalanceCheck(
    selectedWallet,
    selectedAssetBalance,
    totalAmount
  );
  const exceedsMaxRecipients = recipients.length > MAX_BATCH_RECIPIENTS;
  const hasMint = !walletId || selectedAssetBalance !== null;
  const trimmedExternalId = externalId.trim();

  // Canonical form, not the order the recipients were assembled in: the API
  // fingerprints recipients IN ORDER, so a retry that reorders the same set
  // has to send the same bytes or it is refused as a key conflict.
  const request = useMemo(
    () =>
      canonicalTransferBatchRequest({
        ...(trimmedExternalId.length > 0 ? { externalId: trimmedExternalId } : {}),
        sourceCustodyWalletId: walletId,
        token: asset,
        recipients: recipients.map((r) => ({
          counterpartyId: r.counterpartyId,
          counterpartyAccountId: r.counterpartyAccountId,
          amount: r.amount,
        })),
      }),
    [walletId, asset, recipients, trimmedExternalId]
  );
  const recipientsValid = batchSendSchema.safeParse({
    walletId,
    asset,
    externalId,
    recipients,
  }).success;

  const currentStepId = steps[stepIndex].id;
  const isLastStep = stepIndex === steps.length - 1;
  const canProceed = batchCanProceed({
    batchResult,
    selectedWallet,
    currentStepId,
    recipientsValid,
    exceedsBalance,
    hasMint,
  });

  const { data: estimate, error: estimateError } = useSWR(
    currentStepId === "REVIEW" && canProceed && !batchResult
      ? paymentsQueryKeys.batchEstimate({ serializedRequest: JSON.stringify(request) })
      : null,
    () => estimateTransferBatch(request, t),
    { revalidateOnFocus: false }
  );

  const submitBatch = async () => {
    setSubmitting(true);
    const toastId = toast.loading(t("DashboardPayments.batchSend.submitting"), {
      position: "bottom-right",
    });
    // Claimed BEFORE the await and durable per tab: a retry of this exact
    // batch — double press, timeout, reload — carries the SAME key, so the
    // API replays the recorded batch instead of moving the money again.
    const fingerprint = transferBatchRequestFingerprint(request);
    const idempotencyKey = claimTransferBatchIdempotencyKey(fingerprint);
    try {
      const outcome = await createTransferBatch(request, t, idempotencyKey);
      if (outcome.kind === "approval_pending") {
        // The approval executor replays this request under the same key, so
        // the key must outlive the human deciding: pin it for the tab's life.
        // A resubmit after the approval executes replays the recorded batch.
        holdTransferBatchIdempotencyKey(fingerprint);
        toast.info(t("DashboardPayments.batchSend.resultApprovalPending"), {
          id: toastId,
          description: t("DashboardPayments.batchSend.approvalPendingDescription"),
          position: "bottom-right",
        });
        return;
      }
      // The batch row exists — the key is spent, and the next identical batch
      // is a new intent rather than a retry of this one.
      releaseTransferBatchIdempotencyKey(fingerprint);
      const result = outcome.result;
      setBatchResult(result);
      const status = result.batch.status;
      if (status === "confirmed") {
        toast.success(t("DashboardPayments.batchSend.resultConfirmed"), {
          id: toastId,
          position: "bottom-right",
        });
      } else if (status === "partially_failed") {
        toast.warning(t("DashboardPayments.batchSend.resultPartiallyFailed"), {
          id: toastId,
          description: t("DashboardPayments.batchSend.someRecipientsDidNotReceiveFunds"),
          position: "bottom-right",
        });
      } else if (status === "failed") {
        toast.error(t("DashboardPayments.batchSend.resultFailed"), {
          id: toastId,
          position: "bottom-right",
        });
      } else {
        toast.success(t("DashboardPayments.batchSend.resultSubmitted"), {
          id: toastId,
          description: t("DashboardPayments.batchSend.status", { status }),
          position: "bottom-right",
        });
      }
    } catch (error) {
      // A 4xx is a definitive refusal — nothing was recorded, so the key is
      // retired and the next attempt is a fresh intent. A 5xx or a network
      // failure keeps the key: the API may have recorded the batch before the
      // answer was lost, and only a retry with the SAME key can find out
      // without paying every recipient twice. A 409 is the exception among
      // 4xx: it says this key already carries a batch whose payload the API
      // read differently, so the key is the only handle on it.
      if (
        error instanceof TransferBatchRequestError &&
        error.status >= 400 &&
        error.status < 500 &&
        !isTransferBatchKeyConflict(error.status)
      ) {
        releaseTransferBatchIdempotencyKey(fingerprint);
      }
      toast.error(t("DashboardPayments.batchSend.resultFailed"), {
        id: toastId,
        description:
          error instanceof Error ? error.message : t("DashboardPayments.batchSend.resultFailed"),
        position: "bottom-right",
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handlePrimary = async () => {
    if (!canProceed) {
      return;
    }
    if (isLastStep) {
      if (batchResult) {
        router.push(href("/dashboard/payments"));
        return;
      }
      await submitBatch();
      return;
    }
    setStepIndex((current) => current + 1);
  };

  const handleSecondary = () => {
    if (submitting || batchResult) {
      return;
    }
    onExit();
  };

  // Back from review to the rows; nothing has been sent yet.
  const handleBack = () => {
    if (submitting || batchResult) {
      return;
    }
    setStepIndex((current) => Math.max(0, current - 1));
  };

  return {
    stepIndex,
    currentStepId,
    isLastStep,
    canProceed,
    liveWallets,
    walletsLoading,
    liveWalletsError,
    sourceWalletHint:
      signingUnavailable && !batchResult ? t("DashboardPayments.signingUnavailable") : null,
    walletId,
    selectWallet,
    asset,
    displayAsset,
    setAsset,
    externalId,
    setExternalId,
    assetOptions,
    selectedWallet,
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
    steps,
    toggleRecipient,
    setManySelected,
    setRecipientAmount,
    bulkImport,
    estimate: estimate ?? null,
    estimateError: estimateErrorMessage(estimateError, t),
    submitting,
    batchResult,
    handlePrimary,
    handleSecondary,
    handleBack,
  };
}

export type BatchSendWizard = ReturnType<typeof useBatchSendWizard>;
