"use client";

import { compareDecimalAmounts } from "@sdp/solana/amount";
import type {
  CounterpartyAccount,
  PaymentsDashboardWallet,
  PaymentTransferSummary,
} from "@sdp/types";
import { address } from "@solana/kit";
import { CoinsIcon, DollarSignIcon, WalletIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import { paymentsQueryKeys } from "@/app/dashboard/payments/payments-query-key";
import type { CreateTransferInput } from "@/app/dashboard/payments/payments-workspace.data";
import {
  createTransfer,
  fetchCounterpartyAccounts,
  TransferRequestError,
} from "@/app/dashboard/payments/payments-workspace.data";
import {
  claimTransferIdempotencyKey,
  holdTransferIdempotencyKey,
  isTransferKeyConflict,
  releaseTransferIdempotencyKey,
  transferRequestFingerprint,
} from "@/app/dashboard/payments/transfer-idempotency";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import { useZodForm } from "@/lib/use-zod-form";
import type { WizardSummaryDetail } from "../../wizard-summary-list";
import {
  cryptoWalletAccountDetailsSchema,
  ONCHAIN_AMOUNT_PATTERN,
  type OnchainSendFields,
  onchainDestinationSchema,
  onchainDetailsSchema,
  onchainSendSchema,
} from "../schema";
import { walletBalanceAssetOptions } from "../wallet-options";
import { optionalDetail, summaryAmount } from "../wizard-summary";
import { usePaymentsActionWallets } from "./use-payments-action-wallets";
import type { RampWizardStep } from "./use-ramp-wizard";

export const ONCHAIN_SEND_STEP_IDS = ["DESTINATION", "DETAILS", "REVIEW"] as const;
export type OnchainSendStepId = (typeof ONCHAIN_SEND_STEP_IDS)[number];
type Translate = (key: MessageKey, values?: TranslationValues) => string;

export function getOnchainSendSteps(t: Translate): readonly RampWizardStep<OnchainSendStepId>[] {
  return [
    {
      id: "DESTINATION",
      label: t("DashboardPayments.onchainSend.destination"),
      title: t("DashboardPayments.onchainSend.destinationTitle"),
    },
    {
      id: "DETAILS",
      label: t("DashboardPayments.onchainSend.details"),
      title: t("DashboardPayments.onchainSend.detailsTitle"),
    },
    {
      id: "REVIEW",
      label: t("DashboardPayments.onchainSend.review"),
      title: t("DashboardPayments.onchainSend.reviewTitle"),
    },
  ];
}

export function resolveReadySubmission(
  fields: OnchainSendFields,
  destinationAddress: string | null,
  selectedMint: string | null
): CreateTransferInput | null {
  if (fields.walletId === "" || destinationAddress === null || selectedMint === null) {
    return null;
  }
  const baseSubmission = {
    sourceCustodyWalletId: fields.walletId,
    destination: destinationAddress,
    token: address(selectedMint),
    amount: fields.amount,
  };
  const memo = fields.memo.trim();
  return memo === "" ? baseSubmission : { ...baseSubmission, memo };
}

export function canProceedOnchainSend({
  stepId,
  fields,
  destinationAddress,
  exceedsBalance,
  selectedMint,
  readySubmission,
}: {
  stepId: OnchainSendStepId;
  fields: OnchainSendFields;
  destinationAddress: string | null;
  exceedsBalance: boolean;
  selectedMint: string | null;
  readySubmission: CreateTransferInput | null;
}): boolean {
  switch (stepId) {
    case "DESTINATION":
      return onchainDestinationSchema.safeParse(fields).success && destinationAddress !== null;
    case "DETAILS": {
      const hasMintForSelectedAsset = fields.walletId === "" || selectedMint !== null;
      return (
        onchainDetailsSchema.safeParse(fields).success && !exceedsBalance && hasMintForSelectedAsset
      );
    }
    case "REVIEW":
      return readySubmission !== null;
  }
}

export function nextAssetAfterWalletChange(
  currentAsset: string,
  nextAssets: readonly { value: string }[]
): string {
  if (nextAssets.some((asset) => asset.value === currentAsset)) {
    return currentAsset;
  }
  const firstAsset = nextAssets[0];
  return firstAsset === undefined ? "" : firstAsset.value;
}

export function cryptoWalletAddress(account: CounterpartyAccount): string | null {
  if (account.accountKind !== "crypto_wallet") {
    return null;
  }
  const result = cryptoWalletAccountDetailsSchema.safeParse(account.details);
  return result.success ? result.data.address : null;
}

export function onchainAmountExceedsBalance(
  amount: string,
  availableAmount: string | null
): boolean {
  return (
    amount !== "" &&
    availableAmount !== null &&
    ONCHAIN_AMOUNT_PATTERN.test(amount) &&
    compareDecimalAmounts(amount, availableAmount) > 0
  );
}

export interface UseOnchainSendWizardProps {
  wallets: PaymentsDashboardWallet[];
  walletsError: string | null;
  issuedTokenSymbolsByMint: Record<string, string>;
  counterpartyId: string;
  onExit: () => void;
}

export function useOnchainSendWizard({
  wallets,
  walletsError,
  issuedTokenSymbolsByMint,
  counterpartyId,
  onExit,
}: UseOnchainSendWizardProps) {
  const router = useRouter();
  const t = useTranslations();
  const locale = useLocale();
  const steps = getOnchainSendSteps(t);
  const [stepIndex, setStepIndex] = useState(0);
  const { values: fields, setField } = useZodForm(onchainSendSchema, {
    accountId: "",
    walletId: "",
    asset: "",
    amount: "",
    memo: "",
  });
  const [addAccountOpen, setAddAccountOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [transferResult, setTransferResult] = useState<PaymentTransferSummary | null>(null);
  // The approval request a policy parked this payment behind. Like a result,
  // it ends the wizard: sending again would only open another approval.
  const [heldApprovalRequestId, setHeldApprovalRequestId] = useState<string | null>(null);
  const finished = transferResult !== null || heldApprovalRequestId !== null;

  const { liveWallets, walletsLoading, liveWalletsError } = usePaymentsActionWallets(
    wallets,
    walletsError
  );

  const { data: accounts, mutate: mutateAccounts } = useSWR(
    counterpartyId ? paymentsQueryKeys.counterpartyAccounts({ counterpartyId }) : null,
    ([, id]: readonly [string, string]) => fetchCounterpartyAccounts(id, t),
    { revalidateOnFocus: false }
  );
  const accountsLoading = accounts === undefined;
  const cryptoAccounts = useMemo(() => {
    if (accounts === undefined) {
      return [];
    }
    return accounts.filter(
      (account) =>
        account.accountKind === "crypto_wallet" &&
        account.status === "active" &&
        cryptoWalletAddress(account) !== null
    );
  }, [accounts]);

  const selectedWallet = useMemo(() => {
    const wallet = liveWallets.find((candidate) => candidate.id === fields.walletId);
    return wallet === undefined ? null : wallet;
  }, [liveWallets, fields.walletId]);
  const selectedAccount = useMemo(() => {
    const account = cryptoAccounts.find((candidate) => candidate.id === fields.accountId);
    return account === undefined ? null : account;
  }, [cryptoAccounts, fields.accountId]);
  const destinationAddress = selectedAccount === null ? null : cryptoWalletAddress(selectedAccount);

  const assetOptions = useMemo(
    () => walletBalanceAssetOptions(selectedWallet, issuedTokenSymbolsByMint, t),
    [issuedTokenSymbolsByMint, selectedWallet, t]
  );
  const selectedAsset = useMemo(() => {
    const asset = assetOptions.find((candidate) => candidate.value === fields.asset);
    return asset === undefined ? null : asset;
  }, [assetOptions, fields.asset]);

  const selectWallet = (walletId: string) => {
    setField("walletId", walletId);
    const matchingWallet = liveWallets.find((wallet) => wallet.id === walletId);
    const nextWallet = matchingWallet === undefined ? null : matchingWallet;
    const nextAssets = walletBalanceAssetOptions(nextWallet, issuedTokenSymbolsByMint, t);
    const nextAsset = nextAssetAfterWalletChange(fields.asset, nextAssets);
    if (nextAsset !== fields.asset) {
      setField("asset", nextAsset);
    }
  };

  const selectedAssetBalance = useMemo(() => {
    if (selectedWallet === null || selectedWallet.balances === undefined) {
      return null;
    }
    const balance = selectedWallet.balances.find((candidate) => candidate.mint === fields.asset);
    return balance === undefined ? null : balance;
  }, [selectedWallet, fields.asset]);

  let availableAmount: string | null;
  if (selectedWallet === null) {
    availableAmount = null;
  } else if (selectedAssetBalance === null) {
    availableAmount = "0";
  } else {
    availableAmount = selectedAssetBalance.uiAmount;
  }
  const exceedsBalance = onchainAmountExceedsBalance(fields.amount, availableAmount);

  const currentStepId = steps[stepIndex].id;
  const isLastStep = stepIndex === steps.length - 1;
  const readySubmission = resolveReadySubmission(
    fields,
    destinationAddress,
    selectedAssetBalance === null ? null : selectedAssetBalance.mint
  );
  const canProceed = canProceedOnchainSend({
    stepId: currentStepId,
    fields,
    destinationAddress,
    exceedsBalance,
    selectedMint: selectedAssetBalance === null ? null : selectedAssetBalance.mint,
    readySubmission,
  });

  const handleAccountAdded = (account: CounterpartyAccount) => {
    setField("accountId", account.id);
    void mutateAccounts(
      (prev) => {
        const existingAccounts = prev === undefined ? [] : prev;
        return [account, ...existingAccounts.filter((existing) => existing.id !== account.id)];
      },
      { revalidate: true }
    );
    setAddAccountOpen(false);
  };

  const submitTransfer = async (submission: CreateTransferInput) => {
    setSubmitting(true);
    const toastId = toast.loading(t("DashboardPayments.onchainSend.submittingTransfer"), {
      position: "bottom-right",
    });
    // Claimed BEFORE the await and durable per tab: a retry of this exact
    // payment (double press, timeout, reload) carries the SAME key, so the API
    // replays what it recorded instead of moving the money again.
    const fingerprint = transferRequestFingerprint(submission);
    const idempotencyKey = claimTransferIdempotencyKey(fingerprint);
    try {
      const outcome = await createTransfer(submission, t, idempotencyKey);
      if (outcome.kind === "approval_pending") {
        // The approval executor replays this request under the same key, so the
        // key must outlive the person deciding.
        holdTransferIdempotencyKey(fingerprint);
        setHeldApprovalRequestId(outcome.approvalRequestId);
        toast.info(t("DashboardPayments.onchainSend.approvalPendingTitle"), {
          id: toastId,
          description: t("DashboardPayments.onchainSend.approvalPendingDescription"),
          position: "bottom-right",
        });
        return;
      }
      // The transfer row exists, so the key is spent: the next identical send is
      // a new payment rather than a retry of this one.
      releaseTransferIdempotencyKey(fingerprint);
      const transfer = outcome.transfer;
      setTransferResult(transfer);
      toast.success(t("DashboardPayments.onchainSend.transferSubmitted"), {
        id: toastId,
        description: transfer.signature
          ? t("DashboardPayments.onchainSend.transactionSent")
          : t("DashboardPayments.onchainSend.transferStatus", { status: transfer.status }),
        position: "bottom-right",
      });
    } catch (error) {
      // A 4xx is a definitive refusal and retires the key. A 5xx or a network
      // failure keeps it: the API may have recorded the transfer before the
      // answer was lost. A 409 under our own key keeps it too.
      if (
        error instanceof TransferRequestError &&
        error.status >= 400 &&
        error.status < 500 &&
        !isTransferKeyConflict(error.status)
      ) {
        releaseTransferIdempotencyKey(fingerprint);
      }
      toast.error(t("DashboardPayments.onchainSend.transferFailed"), {
        id: toastId,
        description:
          error instanceof Error
            ? error.message
            : t("DashboardPayments.onchainSend.transferFailed"),
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
      if (finished) {
        router.push("/dashboard/payments");
        return;
      }
      if (readySubmission !== null) {
        await submitTransfer(readySubmission);
      }
      return;
    }
    setStepIndex((current) => current + 1);
  };

  const handleSecondary = () => {
    if (submitting || finished) {
      return;
    }
    if (stepIndex === 0) {
      onExit();
      return;
    }
    setStepIndex((current) => Math.max(0, current - 1));
  };

  const summaryDetails: WizardSummaryDetail[] = [
    ...optionalDetail(
      selectedWallet === null ? null : selectedWallet.label,
      t("DashboardPayments.onchainSend.sourceWallet"),
      WalletIcon
    ),
    ...optionalDetail(
      selectedAsset === null ? null : selectedAsset.label,
      t("DashboardPayments.onchainSend.asset"),
      CoinsIcon
    ),
    ...optionalDetail(
      summaryAmount(fields.amount, locale),
      t("DashboardPayments.onchainSend.amount"),
      DollarSignIcon
    ),
  ];

  return {
    summaryDetails,
    stepIndex,
    currentStepId,
    isLastStep,
    canProceed,
    readySubmission,
    liveWallets,
    walletsLoading,
    liveWalletsError,
    cryptoAccounts,
    accountsLoading,
    counterpartyId,
    selectedWallet,
    selectedAccount,
    destinationAddress,
    assetOptions,
    selectedAsset,
    selectedAssetBalance,
    availableAmount,
    exceedsBalance,
    fields,
    setField,
    selectWallet,
    addAccountOpen,
    setAddAccountOpen,
    handleAccountAdded,
    submitting,
    transferResult,
    heldApprovalRequestId,
    finished,
    handlePrimary,
    handleSecondary,
  };
}

export type OnchainSendWizard = ReturnType<typeof useOnchainSendWizard>;
