"use client";

import { compareDecimalAmounts } from "@sdp/solana/amount";
import type { CounterpartyAccount } from "@sdp/types/counterparties";
import type { PaymentsDashboardWallet, PaymentTransferSummary } from "@sdp/types/payments";
import { address } from "@solana/kit";
import { CoinsIcon, DollarSignIcon, WalletIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import { paymentsQueryKeys } from "@/app/dashboard/[projectId]/payments/payments-query-key";
import type { CreateTransferInput } from "@/app/dashboard/[projectId]/payments/payments-workspace.data";
import { fetchCounterpartyAccounts } from "@/app/dashboard/[projectId]/payments/payments-workspace.data";
import {
  cryptoWalletAccountDetailsSchema,
  ONCHAIN_AMOUNT_PATTERN,
  type OnchainSendFields,
  onchainDestinationSchema,
  onchainDetailsSchema,
  onchainSendSchema,
} from "@/app/dashboard/[projectId]/payments/ramps/schema";
import { walletBalanceAssetOptions } from "@/app/dashboard/[projectId]/payments/ramps/wallet-options";
import {
  optionalDetail,
  summaryAmount,
} from "@/app/dashboard/[projectId]/payments/ramps/wizard-summary";
import { sendTransferUnderKey } from "@/app/dashboard/[projectId]/payments/transfer-idempotency";
import {
  type TokenAmountEntry,
  useTokenAmountEntry,
} from "@/app/dashboard/[projectId]/payments/use-token-amount-entry";
import type { WizardSummaryDetail } from "@/app/dashboard/[projectId]/payments/wizard-summary-list";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import type { TranslationValues } from "@/i18n/translate";
import { isMovementInFlight } from "@/lib/idempotency";
import { DEMO_PREFILL_AMOUNTS } from "@/lib/payments-demo/demo-prefill";
import { usePaymentsDemo } from "@/lib/payments-demo/payments-demo-context";
import { useProjectHref } from "@/lib/use-dashboard-project";
import { useZodForm } from "@/lib/use-zod-form";
import { usePaymentsActionWallets } from "./use-payments-action-wallets";
import type { RampWizardStep } from "./use-ramp-wizard.redesign";
import { type UnresolvedTransfer, useUnresolvedTransfers } from "./use-unresolved-transfers";

// One details step (contact, destination, wallet, amount, memo) and a review that also shows the
// outcome once sent.
export const ONCHAIN_SEND_STEP_IDS = ["DETAILS", "REVIEW"] as const;
export type OnchainSendStepId = (typeof ONCHAIN_SEND_STEP_IDS)[number];
type Translate = (key: MessageKey, values?: TranslationValues) => string;

type SubmittedTransfer = Pick<PaymentTransferSummary, "status" | "signature">;

/** Where a submitted transfer stands, for the toast that reports it. */
function submittedTransferOutcome(transfer: SubmittedTransfer): "processing" | "sent" | "recorded" {
  if (isMovementInFlight(transfer.status)) return "processing";
  if (transfer.signature) return "sent";
  return "recorded";
}

/** What the submitted-transfer toast says about the transfer it answered with. */
function submittedTransferDescription(transfer: SubmittedTransfer, t: Translate): string {
  const outcome = submittedTransferOutcome(transfer);
  switch (outcome) {
    // Still processing: the key is kept, so a resend returns this payment (APE-461).
    case "processing":
      return t("Shared.idempotency.processingCheckStatus");
    case "sent":
      return t("DashboardPayments.onchainSend.transactionSent");
    case "recorded":
      return t("DashboardPayments.onchainSend.transferStatus", { status: transfer.status });
    default: {
      const unreachable: never = outcome;
      throw new Error(`Unknown transfer outcome: ${String(unreachable)}`);
    }
  }
}

export function getOnchainSendSteps(t: Translate): readonly RampWizardStep<OnchainSendStepId>[] {
  return [
    {
      id: "DETAILS",
      label: t("DashboardPayments.onchainSend.details"),
      title: t("DashboardPayments.whoAreYouPaying"),
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
    case "DETAILS": {
      const hasMintForSelectedAsset = fields.walletId === "" || selectedMint !== null;
      return (
        onchainDestinationSchema.safeParse(fields).success &&
        destinationAddress !== null &&
        onchainDetailsSchema.safeParse(fields).success &&
        !exceedsBalance &&
        hasMintForSelectedAsset
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

function useOnchainSubmission(signingUnavailable: boolean, t: Translate) {
  const [submitting, setSubmitting] = useState(false);
  const [transferResult, setTransferResult] = useState<PaymentTransferSummary | null>(null);
  const { unresolvedFor, settle } = useUnresolvedTransfers();
  const finished = transferResult !== null;

  /**
   * Sends the attempt, what the user typed as `entry`, under its key. An
   * attempt left unresolved is what `entry` is sent as until one resolves it.
   */
  const submitTransfer = async (entry: string, attempt: UnresolvedTransfer) => {
    const { submission } = attempt;
    if (signingUnavailable) return;
    setSubmitting(true);
    const toastId = toast.loading(t("DashboardPayments.onchainSend.submittingTransfer"), {
      position: "bottom-right",
    });
    try {
      const { transfer } = await sendTransferUnderKey(submission, t);
      setTransferResult(transfer);
      toast.success(t("DashboardPayments.onchainSend.transferSubmitted"), {
        id: toastId,
        description: submittedTransferDescription(transfer, t),
        position: "bottom-right",
      });
    } catch (error) {
      toast.error(t("DashboardPayments.onchainSend.transferFailed"), {
        id: toastId,
        description:
          error instanceof Error
            ? error.message
            : t("DashboardPayments.onchainSend.transferFailed"),
        position: "bottom-right",
      });
    } finally {
      settle(entry, attempt);
      setSubmitting(false);
    }
  };

  return { submitting, transferResult, finished, submitTransfer, unresolvedFor };
}

function useOnchainAssetSelection(
  selectedWallet: PaymentsDashboardWallet | null,
  fields: OnchainSendFields,
  issuedTokenSymbolsByMint: Record<string, string>,
  t: Translate
) {
  const assetOptions = useMemo(
    () => walletBalanceAssetOptions(selectedWallet, issuedTokenSymbolsByMint, t),
    [issuedTokenSymbolsByMint, selectedWallet, t]
  );
  const selectedAsset = useMemo(() => {
    const asset = assetOptions.find((candidate) => candidate.value === fields.asset);
    return asset === undefined ? null : asset;
  }, [assetOptions, fields.asset]);

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
    availableAmount = selectedAssetBalance.tokenAmount;
  }

  return { assetOptions, selectedAsset, selectedAssetBalance, availableAmount };
}

export function useOnchainSendWizard({
  wallets,
  walletsError,
  issuedTokenSymbolsByMint,
  counterpartyId,
  onExit,
}: UseOnchainSendWizardProps) {
  const router = useRouter();
  const href = useProjectHref();
  const t = useTranslations();
  const locale = useLocale();
  const steps = getOnchainSendSteps(t);
  const [stepIndex, setStepIndex] = useState(0);
  const demo = usePaymentsDemo();
  const {
    values: fields,
    setField,
    setFields,
  } = useZodForm(onchainSendSchema, {
    accountId: "",
    walletId: "",
    asset: "",
    amountUnit: "token",
    amount: demo ? DEMO_PREFILL_AMOUNTS.send : "",
    displayAmount: "",
    memo: "",
  });
  const [addAccountOpen, setAddAccountOpen] = useState(false);

  // A destination belongs to one contact; picking another contact clears it.
  const accountCounterpartyRef = useRef(counterpartyId);
  useEffect(() => {
    if (accountCounterpartyRef.current === counterpartyId) return;
    accountCounterpartyRef.current = counterpartyId;
    setField("accountId", "");
  }, [counterpartyId, setField]);

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
  const signingUnavailable =
    fields.walletId !== "" && selectedWallet?.isRuntimeExecutionAllowed !== true;
  const selectedAccount = useMemo(() => {
    const account = cryptoAccounts.find((candidate) => candidate.id === fields.accountId);
    return account === undefined ? null : account;
  }, [cryptoAccounts, fields.accountId]);
  const destinationAddress = selectedAccount === null ? null : cryptoWalletAddress(selectedAccount);
  const { submitting, transferResult, finished, submitTransfer, unresolvedFor } =
    useOnchainSubmission(signingUnavailable, t);
  const { assetOptions, selectedAsset, selectedAssetBalance, availableAmount } =
    useOnchainAssetSelection(selectedWallet, fields, issuedTokenSymbolsByMint, t);
  const selectedMint = selectedAssetBalance === null ? null : selectedAssetBalance.mint;
  // A send fixes its debit. For a display-rule mint the user may type what wallets show;
  // the quote's token amount is what is checked and sent.
  const amountEntry = useTokenAmountEntry({
    mint: selectedMint,
    basis: "debit",
    fields,
    setFields,
  });
  // The payment as the user typed it. While its last attempt is unresolved it is
  // shown and sent as that attempt was, never at a token amount a later quote priced.
  const typedEntry = JSON.stringify([
    fields.walletId,
    destinationAddress,
    selectedMint,
    amountEntry.unit,
    amountEntry.unit === "display" ? fields.displayAmount.trim() : fields.amount.trim(),
    fields.memo.trim(),
  ]);
  const unresolved = unresolvedFor(typedEntry);
  const shownEntry: TokenAmountEntry =
    unresolved === null
      ? amountEntry
      : {
          ...amountEntry,
          tokenAmount: unresolved.submission.amount,
          quote: unresolved.quote,
          quoteError: null,
        };
  // As sent: the unit the input is in, and the amount in token units.
  const sendFields = { ...fields, amountUnit: amountEntry.unit, amount: shownEntry.tokenAmount };
  const exceedsBalance = onchainAmountExceedsBalance(sendFields.amount, availableAmount);

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

  const currentStepId = steps[stepIndex].id;
  const isLastStep = stepIndex === steps.length - 1;
  const readySubmission =
    unresolved === null
      ? resolveReadySubmission(sendFields, destinationAddress, selectedMint)
      : unresolved.submission;
  const canProceed =
    finished ||
    (!amountEntry.quoteInFlight &&
      !signingUnavailable &&
      canProceedOnchainSend({
        stepId: currentStepId,
        fields: sendFields,
        destinationAddress,
        exceedsBalance,
        selectedMint,
        readySubmission,
      }));

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

  const handlePrimary = async () => {
    if (!canProceed) {
      return;
    }
    if (isLastStep) {
      if (finished) {
        router.push(href("/dashboard/payments"));
        return;
      }
      // A display amount's token amount holds only until its quote expires. A retry
      // of an unresolved attempt resends that attempt's amount, so it needs no quote.
      if (unresolved === null && !amountEntry.canSubmitAt(Date.now())) {
        amountEntry.refreshQuote();
        toast.error(t("DashboardPayments.tokenAmount.quoteExpired"), { position: "bottom-right" });
        return;
      }
      if (readySubmission !== null) {
        await submitTransfer(typedEntry, { submission: readySubmission, quote: shownEntry.quote });
      }
      return;
    }
    setStepIndex((current) => current + 1);
  };

  const handleSecondary = () => {
    if (submitting || finished || amountEntry.quoteInFlight) {
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
      summaryAmount(sendFields.amount, locale),
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
    sourceWalletHint:
      signingUnavailable && !transferResult ? t("DashboardPayments.signingUnavailable") : null,
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
    /** The amount entry as shown: an unresolved attempt's quote and token amount while it is kept. */
    amountEntry: shownEntry,
    /** The amount sent, in token units: typed, priced from a display amount, or an unresolved attempt's. */
    sendAmount: sendFields.amount,
    quoteInFlight: amountEntry.quoteInFlight,
    fields,
    setField,
    selectWallet,
    addAccountOpen,
    setAddAccountOpen,
    handleAccountAdded,
    submitting,
    transferResult,
    finished,
    handlePrimary,
    handleSecondary,
  };
}

export type OnchainSendWizard = ReturnType<typeof useOnchainSendWizard>;
