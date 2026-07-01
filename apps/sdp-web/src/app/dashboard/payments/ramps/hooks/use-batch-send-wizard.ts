"use client";

import {
  type CounterpartyAccountSummary,
  isWellKnownTokenSymbol,
  type PaymentsDashboardWallet,
  type SolanaCluster,
  wellKnownMint,
} from "@sdp/types";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import {
  type CreateTransferBatchResult,
  createTransferBatch,
  estimateTransferBatch,
  fetchBatchRecipients,
  fetchWallets,
} from "@/app/dashboard/payments/payments-workspace.data";
import type { BulkImportRow } from "../bulk-import";
import { batchSendSchema, MAX_BATCH_RECIPIENTS } from "../schema";
import { walletBalanceAssetOptions } from "../wallet-options";
import type { RampWizardStep } from "./use-ramp-wizard";

export const BATCH_SEND_STEPS = [
  { id: "RECIPIENTS", label: "Recipients", title: "Pay multiple recipients" },
  { id: "REVIEW", label: "Review", title: "Review batch" },
] as const satisfies readonly RampWizardStep[];

export type BatchSendStepId = (typeof BATCH_SEND_STEPS)[number]["id"];

export type BatchEligibleRecipient = CounterpartyAccountSummary;

const PAYMENTS_ACTION_WALLETS_KEY = "payments-action-wallets";
const RECIPIENTS_PAGE_SIZE = 6;

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
  const [stepIndex, setStepIndex] = useState(0);
  const [walletId, setWalletId] = useState("");
  const [asset, setAsset] = useState("");
  const [entries, setEntries] = useState<Record<string, BatchRecipientEntry>>({});
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [batchResult, setBatchResult] = useState<CreateTransferBatchResult | null>(null);

  const { data: swrWallets, error: walletsFetchError } = useSWR<PaymentsDashboardWallet[]>(
    PAYMENTS_ACTION_WALLETS_KEY,
    () => fetchWallets({ includeBalances: true }),
    {
      fallbackData: wallets.length > 0 ? wallets : undefined,
      revalidateOnFocus: false,
      revalidateIfStale: false,
    }
  );
  const liveWallets = swrWallets ?? wallets;
  const walletsLoading = swrWallets === undefined && !walletsFetchError;
  const liveWalletsError = walletsFetchError
    ? walletsFetchError instanceof Error
      ? walletsFetchError.message
      : "Request failed."
    : swrWallets === undefined
      ? walletsError
      : null;

  const trimmedSearch = search.trim();
  const { data: recipientPage, isLoading: recipientsLoading } = useSWR(
    ["batch-recipients", page, trimmedSearch],
    () =>
      fetchBatchRecipients({
        page,
        pageSize: RECIPIENTS_PAGE_SIZE,
        search: trimmedSearch.length > 0 ? trimmedSearch : undefined,
      }),
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
    () => walletBalanceAssetOptions(selectedWallet, issuedTokenSymbolsByMint),
    [issuedTokenSymbolsByMint, selectedWallet]
  );
  const selectedAssetBalance = useMemo(
    () => selectedWallet?.balances?.find((balance) => balance.mint === asset) ?? null,
    [selectedWallet, asset]
  );
  const displayAsset = assetOptions.find((option) => option.value === asset)?.label ?? "";

  const selectWallet = (nextWalletId: string) => {
    setWalletId(nextWalletId);
    const nextWallet = liveWallets.find((wallet) => wallet.walletId === nextWalletId) ?? null;
    const nextAssets = walletBalanceAssetOptions(nextWallet, issuedTokenSymbolsByMint);
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
    const resolved = await fetchBatchRecipients({ ids });
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
      throw new Error(`${currency} is not available on this network.`);
    }

    const nextEntries = mint === asset ? { ...entries, ...additions } : additions;
    if (Object.keys(nextEntries).length > MAX_BATCH_RECIPIENTS) {
      throw new Error(
        `A batch can have at most ${MAX_BATCH_RECIPIENTS} recipients. This import would bring the total to ${Object.keys(nextEntries).length}.`
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

  const totalAmount = useMemo(
    () =>
      recipients.reduce((sum, r) => {
        const value = Number(r.amount);
        return sum + (Number.isFinite(value) ? value : 0);
      }, 0),
    [recipients]
  );
  let availableAmount: number | null = null;
  if (selectedWallet) {
    availableAmount = selectedAssetBalance ? Number(selectedAssetBalance.uiAmount) : 0;
  }
  const exceedsBalance =
    totalAmount > 0 && availableAmount !== null && totalAmount > availableAmount;
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

  const currentStepId = BATCH_SEND_STEPS[stepIndex].id;
  const isLastStep = stepIndex === BATCH_SEND_STEPS.length - 1;
  const canProceed =
    currentStepId === "RECIPIENTS" ? recipientsValid && !exceedsBalance && hasMint : true;

  const { data: estimate, error: estimateError } = useSWR(
    currentStepId === "REVIEW" && canProceed && !batchResult
      ? ["batch-estimate", JSON.stringify(request)]
      : null,
    () => estimateTransferBatch(request),
    { revalidateOnFocus: false }
  );

  const submitBatch = async () => {
    setSubmitting(true);
    const toastId = toast.loading("Submitting batch.", { position: "bottom-right" });
    try {
      const result = await createTransferBatch(request);
      setBatchResult(result);
      const status = result.batch.status;
      if (status === "confirmed") {
        toast.success("Batch sent.", { id: toastId, position: "bottom-right" });
      } else if (status === "partially_failed") {
        toast.warning("Batch partially failed.", {
          id: toastId,
          description: "Some recipients did not receive funds.",
          position: "bottom-right",
        });
      } else if (status === "failed") {
        toast.error("Batch failed.", { id: toastId, position: "bottom-right" });
      } else {
        toast.success("Batch submitted.", {
          id: toastId,
          description: `Status: ${status}`,
          position: "bottom-right",
        });
      }
    } catch (error) {
      toast.error("Batch failed.", {
        id: toastId,
        description: error instanceof Error ? error.message : "Batch failed.",
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
    toggleRecipient,
    setManySelected,
    setRecipientAmount,
    bulkImport,
    estimate: estimate ?? null,
    estimateError: estimateError
      ? estimateError instanceof Error
        ? estimateError.message
        : "Estimate failed."
      : null,
    submitting,
    batchResult,
    handlePrimary,
    handleSecondary,
  };
}

export type BatchSendWizard = ReturnType<typeof useBatchSendWizard>;
