"use client";

import type {
  PaymentOfframpQuoteRequest,
  PaymentRampInstruction,
  PaymentTransferSummary,
  RampCryptoDeposit,
} from "@sdp/types";
import { address } from "@solana/kit";
import { BanknoteIcon, DollarSignIcon, WalletIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import useSWRMutation from "swr/mutation";
import { paymentsQueryKeys } from "@/app/dashboard/payments/payments-query-key";
import {
  type CreateTransferInput,
  createTransfer,
  fetchTransferById,
} from "@/app/dashboard/payments/payments-workspace.data";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import { offrampPairs, toRampCryptoToken } from "@/lib/ramps";
import type { WizardSummaryDetail } from "../../wizard-summary-list";
import { getRampTransferState } from "../ramp-transfer-state";
import { sourceWalletSchema, withdrawAmountSchema, withdrawSelectionSchema } from "../schema";
import {
  memoSummaryDetails,
  optionalDetail,
  providerSummaryDetail,
  summaryAmount,
} from "../wizard-summary";
import { type RampWizardStep, type UseRampWizardProps, useRampWizard } from "./use-ramp-wizard";

type CryptoDepositInstruction = Extract<PaymentRampInstruction, { kind: "crypto_deposit" }>;

function isCryptoDepositInstruction(
  instruction: PaymentRampInstruction
): instruction is CryptoDepositInstruction {
  return "kind" in instruction && instruction.kind === "crypto_deposit";
}

type Translate = (key: MessageKey, values?: TranslationValues) => string;
export type OfframpStepId = "WALLET" | "WITHDRAW" | "MEMO" | "COMPLETE" | "REQUIREMENTS";

export function getOfframpSteps(t: Translate): readonly RampWizardStep<OfframpStepId>[] {
  return [
    {
      id: "WALLET",
      label: t("DashboardPayments.ramps.offrampWalletStep"),
      title: t("DashboardPayments.ramps.offrampWalletTitle"),
    },
    {
      id: "WITHDRAW",
      label: t("DashboardPayments.ramps.offrampWithdrawStep"),
      title: t("DashboardPayments.ramps.offrampWithdrawTitle"),
    },
    {
      id: "MEMO",
      label: t("DashboardPayments.ramps.rampMemoStep"),
      title: t("DashboardPayments.ramps.rampMemoStepTitle"),
    },
    {
      id: "COMPLETE",
      label: t("DashboardPayments.ramps.offrampCompleteStep"),
      title: t("DashboardPayments.ramps.offrampCompleteTitle"),
    },
  ];
}

function getOfframpRequirementsStep(t: Translate): RampWizardStep<OfframpStepId> {
  return {
    id: "REQUIREMENTS",
    label: t("DashboardPayments.ramps.payoutDetailsStep"),
    title: t("DashboardPayments.ramps.payoutDetailsTitle"),
  };
}

export function useOfframpWizard(props: UseRampWizardProps) {
  const { sdpEnvironment } = useDashboardWorkspace();
  const t = useTranslations();
  const locale = useLocale();
  const [quoteExpired, setQuoteExpired] = useState(false);
  const {
    trigger: triggerCreateTransfer,
    data: onchainSendResult,
    isMutating: onchainSendLoading,
    reset: resetCreateTransfer,
  } = useSWRMutation(
    paymentsQueryKeys.createTransfer(),
    (_key, { arg }: { arg: CreateTransferInput }) => createTransfer(arg, t)
  );

  const wizard = useRampWizard<OfframpStepId>(props, {
    pairs: offrampPairs(sdpEnvironment),
    steps: getOfframpSteps(t),
    stepSchemas: { WALLET: sourceWalletSchema, WITHDRAW: withdrawAmountSchema },
    quoteStepId: "MEMO",
    memoStepId: "MEMO",
    requirements: {
      step: getOfframpRequirementsStep(t),
      insertAfter: "MEMO",
      direction: "offramp",
    },
    selectionSchema: withdrawSelectionSchema,
    quoteEndpoint: "/api/dashboard/payments/ramps/offramp/quote",
    buildQuotePayload: ({
      fields,
      selectedWallet,
      provider,
      selectedRampPair,
      cryptoToken,
      rampsMemo,
    }) =>
      ({
        provider,
        counterpartyId: fields.counterpartyId,
        sourceWallet: selectedWallet.walletId,
        cryptoToken,
        fiatCurrency: selectedRampPair.fiatCurrency,
        cryptoAmount: fields.amount.trim(),
        rampsMemo,
      }) satisfies PaymentOfframpQuoteRequest,
    onQuoteCreated: () => {
      resetCreateTransfer();
      setQuoteExpired(false);
    },
  });

  const quoteExpiresAt =
    wizard.quote?.deliveryMode === "manual_instructions" && "expiresAt" in wizard.quote
      ? wizard.quote.expiresAt
      : undefined;

  useEffect(() => {
    if (!quoteExpiresAt) {
      return;
    }
    const remainingMs = Date.parse(quoteExpiresAt) - Date.now();
    if (!Number.isFinite(remainingMs)) {
      return;
    }
    if (remainingMs <= 0) {
      setQuoteExpired(true);
      return;
    }
    const timeoutId = window.setTimeout(() => setQuoteExpired(true), remainingMs);
    return () => window.clearTimeout(timeoutId);
  }, [quoteExpiresAt]);

  const transferStatusKey = wizard.quoteTransferId
    ? paymentsQueryKeys.offrampTransferStatus({ transferId: wizard.quoteTransferId })
    : null;
  const { data: transferStatus, isValidating: transferStatusLoading } = useSWR(
    transferStatusKey,
    ([, transferId]): Promise<PaymentTransferSummary> => fetchTransferById({ transferId }, t),
    {
      refreshInterval: (transfer) =>
        transfer && getRampTransferState(transfer.status).terminal ? 0 : 3000,
      revalidateOnFocus: true,
      dedupingInterval: 0,
    }
  );

  // Where the crypto must be sent: the manual provider's deposit instruction,
  // or the deposit wallet a hosted provider reported while the sale awaits
  // payment (the provider can rebind it, so the polled transfer always wins).
  const depositTarget = useMemo((): RampCryptoDeposit | null => {
    const quote = wizard.quote;
    if (quote?.deliveryMode === "manual_instructions") {
      const instruction = quote.paymentInstructions?.find(isCryptoDepositInstruction);
      return instruction
        ? {
            destinationAddress: instruction.destinationAddress,
            amount: wizard.fields.amount.trim(),
          }
        : null;
    }
    if (
      quote?.deliveryMode === "hosted" &&
      transferStatus?.status === "awaiting_payment" &&
      transferStatus.cryptoDeposit
    ) {
      return transferStatus.cryptoDeposit;
    }
    return null;
  }, [wizard.quote, wizard.fields.amount, transferStatus]);

  const offrampCryptoToken = toRampCryptoToken(wizard.selectedRampPair.assetRail);
  // The transfers API requires the mint address, not the token symbol.
  const sourceTokenMint = useMemo(() => {
    const balance = wizard.selectedWallet?.balances?.find(
      (entry) => entry.token === offrampCryptoToken
    );
    return balance?.mint ?? null;
  }, [wizard.selectedWallet, offrampCryptoToken]);

  const amount = summaryAmount(wizard.fields.amount, locale);
  const summaryDetails: WizardSummaryDetail[] = [
    ...optionalDetail(
      wizard.selectedWallet === null ? null : wizard.selectedWallet.label,
      t("DashboardPayments.ramps.sourceWallet"),
      WalletIcon
    ),
    ...optionalDetail(
      amount === null ? null : `${amount} ${offrampCryptoToken}`,
      t("DashboardPayments.ramps.amount"),
      DollarSignIcon
    ),
    {
      icon: BanknoteIcon,
      label: t("DashboardPayments.payoutCurrency"),
      value: wizard.selectedRampPair.fiatCurrency,
    },
    ...providerSummaryDetail(t, wizard.fields.provider),
    ...memoSummaryDetails(t, wizard.memoRows),
  ];

  const hasCryptoDepositInstruction = depositTarget !== null;
  const canSendOnchain =
    hasCryptoDepositInstruction &&
    sourceTokenMint !== null &&
    wizard.fields.walletId.length > 0 &&
    wizard.quoteTransferId !== null;

  const sendCryptoToDeposit = async () => {
    const transferId = wizard.quoteTransferId;
    if (
      !depositTarget ||
      !sourceTokenMint ||
      !wizard.fields.walletId ||
      !wizard.selectedWallet ||
      !transferId
    ) {
      return;
    }
    if (onchainSendLoading || onchainSendResult) {
      return;
    }
    // Re-check the timestamp at call time — the armed timeout only covers renders.
    if (quoteExpiresAt && Date.parse(quoteExpiresAt) <= Date.now()) {
      setQuoteExpired(true);
      toast.error(t("DashboardPayments.ramps.quoteExpired"), {
        description: t("DashboardPayments.ramps.status.quoteExpiredPayoutDescription"),
        position: "bottom-right",
      });
      return;
    }

    const toastId = toast.loading(t("DashboardPayments.ramps.submittingOnchainTransfer"), {
      position: "bottom-right",
    });

    try {
      const transfer = await triggerCreateTransfer({
        transferId,
        sourceCustodyWalletId: wizard.selectedWallet.id,
        destination: depositTarget.destinationAddress,
        token: address(sourceTokenMint),
        amount: depositTarget.amount,
      });
      if (transfer.id !== transferId) {
        throw new Error(t("DashboardPayments.ramps.transferFailed"));
      }
      toast.success(t("DashboardPayments.ramps.transferSubmitted"), {
        id: toastId,
        description: transfer.signature
          ? t("DashboardPayments.ramps.transactionSentSuccessfully")
          : t("DashboardPayments.ramps.transferStatus", { status: transfer.status }),
        position: "bottom-right",
      });
    } catch (error) {
      toast.error(t("DashboardPayments.ramps.transferFailed"), {
        id: toastId,
        description:
          error instanceof Error ? error.message : t("DashboardPayments.ramps.transferFailed"),
        position: "bottom-right",
      });
    }
  };

  return {
    ...wizard,
    summaryDetails,
    transferStatus,
    transferStatusLoading,
    sourceTokenMint,
    depositTarget,
    hasCryptoDepositInstruction,
    canSendOnchain,
    onchainSendLoading,
    onchainSendResult: onchainSendResult ?? null,
    sendCryptoToDeposit,
    quoteExpired,
  };
}

export type OfframpWizard = ReturnType<typeof useOfframpWizard>;
