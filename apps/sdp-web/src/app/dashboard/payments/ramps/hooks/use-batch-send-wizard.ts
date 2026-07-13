"use client";

import {
  type CounterpartyAccountSummary,
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
import { shortenAddress } from "@/app/dashboard/payments/payments-overview.utils";
import {
  type CreateTransferBatchResult,
  createTransferBatch,
  estimateTransferBatch,
  fetchBatchRecipients,
} from "@/app/dashboard/payments/payments-workspace.data";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import type { BulkImportRow } from "../bulk-import";
import { batchSendSchema, MAX_BATCH_RECIPIENTS, ONCHAIN_AMOUNT_PATTERN } from "../schema";
import { walletBalanceAssetOptions } from "../wallet-options";
import { usePaymentsActionWallets } from "./use-payments-action-wallets";
import type { RampWizardStep } from "./use-ramp-wizard";

type Translate = (key: MessageKey, values?: TranslationValues) => string;
export type BatchSendStepId = "RECIPIENTS" | "REVIEW";

export function getBatchSendSteps(t: Translate): readonly RampWizardStep<BatchSendStepId>[] {
  return [
    {
      id: "RECIPIENTS",
      label: t("DashboardPayments.batchSend.recipientsStep"),
      title: t("DashboardPayments.batchSend.recipientsTitle"),
    },
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

export function useBatchSendWizard({
  wallets,
  walletsError,
  issuedTokenSymbolsByMint,
  cluster,
  onExit,
}: UseBatchSendWizardProps) {
  const router = useRouter();
  const t = useTranslations();
  const steps = getBatchSendSteps(t);
  const [stepIndex, setStepIndex] = useState(0);
  const [walletId, setWalletId] = useState("");
  const [asset, setAsset] = useState("");
  const [entries, setEntries] = useState<Record<string, BatchRecipientEntry>>({});
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [batchResult, setBatchResult] = useState<CreateTransferBatchResult | null>(null);

  const { liveWallets, walletsLoading, liveWalletsError } = usePaymentsActionWallets(
    wallets,
    walletsError
  );

  const trimmedSearch = search.trim();
  const { data: recipientPage, isLoading: recipientsLoading } = useSWR(
    ["batch-recipients", page, trimmedSearch],
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

  const selectedWallet = useMemo(
    () => liveWallets.find((wallet) => wallet.walletId === walletId) ?? null,
    [liveWallets, walletId]
  );
  const assetOptions = useMemo(
    () =>
      walletBalanceAssetOptions(selectedWallet, issuedTokenSymbolsByMint, t).map((option) => {
        const known =
          WELL_KNOWN_TOKEN_BY_MINT.has(option.value) ||
          Boolean(issuedTokenSymbolsByMint[option.value]);
        return {
          value: option.value,
          label: option.label === option.value ? shortenAddress(option.value) : option.label,
          description: known ? undefined : t("DashboardPayments.batchSend.customToken"),
        };
      }),
    [issuedTokenSymbolsByMint, selectedWallet, t]
  );
  const selectedAssetBalance = useMemo(
    () => selectedWallet?.balances?.find((balance) => balance.mint === asset) ?? null,
    [selectedWallet, asset]
  );
  const displayAsset = assetOptions.find((option) => option.value === asset)?.label ?? "";

  const selectWallet = (nextWalletId: string) => {
    setWalletId(nextWalletId);
    const nextWallet = liveWallets.find((wallet) => wallet.walletId === nextWalletId) ?? null;
    const nextAssets = walletBalanceAssetOptions(nextWallet, issuedTokenSymbolsByMint, t);
    if (!nextAssets.some((option) => option.value === asset)) {
      const preferred = nextAssets.find((option) => option.label === "USDC") ?? nextAssets[0];
      setAsset(preferred?.value ?? "");
    }
  };

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

  const bulkImport = async (rows: BulkImportRow[]): Promise<{ unresolved: string[] }> => {
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

    const { currency } = rows[0];
    const mint = isWellKnownTokenSymbol(currency) ? wellKnownMint(currency, cluster) : currency;
    if (!mint) {
      throw new Error(t("DashboardPayments.batchSend.tokenUnavailableOnNetwork", { currency }));
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
  const totalAmountValue = Number(totalAmount);
  let availableAmount: number | null = null;
  if (selectedWallet) {
    availableAmount = selectedAssetBalance ? Number(selectedAssetBalance.uiAmount) : 0;
  }
  const exceedsBalance =
    totalAmountValue > 0 && availableAmount !== null && totalAmountValue > availableAmount;
  const exceedsMaxRecipients = recipients.length > MAX_BATCH_RECIPIENTS;
  const hasMint = !walletId || selectedAssetBalance !== null;

  const request = useMemo(
    () => ({
      source: walletId,
      token: asset,
      recipients: recipients.map((r) => ({
        counterpartyId: r.counterpartyId,
        counterpartyAccountId: r.counterpartyAccountId,
        amount: r.amount,
      })),
    }),
    [walletId, asset, recipients]
  );
  const recipientsValid = batchSendSchema.safeParse({ walletId, asset, recipients }).success;

  const currentStepId = steps[stepIndex].id;
  const isLastStep = stepIndex === steps.length - 1;
  const canProceed =
    currentStepId === "RECIPIENTS" ? recipientsValid && !exceedsBalance && hasMint : true;

  const { data: estimate, error: estimateError } = useSWR(
    currentStepId === "REVIEW" && canProceed && !batchResult
      ? ["batch-estimate", JSON.stringify(request)]
      : null,
    () => estimateTransferBatch(request, t),
    { revalidateOnFocus: false }
  );

  const submitBatch = async () => {
    setSubmitting(true);
    const toastId = toast.loading(t("DashboardPayments.batchSend.submitting"), {
      position: "bottom-right",
    });
    try {
      const result = await createTransferBatch(request, t);
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
        router.push("/dashboard/payments");
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

  return {
    stepIndex,
    currentStepId,
    isLastStep,
    canProceed,
    liveWallets,
    walletsLoading,
    liveWalletsError,
    walletId,
    selectWallet,
    asset,
    displayAsset,
    setAsset,
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
    estimateError: estimateError
      ? estimateError instanceof Error
        ? estimateError.message
        : t("DashboardPayments.batchSend.estimateFailed")
      : null,
    submitting,
    batchResult,
    handlePrimary,
    handleSecondary,
  };
}

export type BatchSendWizard = ReturnType<typeof useBatchSendWizard>;
