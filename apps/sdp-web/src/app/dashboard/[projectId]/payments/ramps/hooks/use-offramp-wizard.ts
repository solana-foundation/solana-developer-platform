"use client";

import { getCryptoRailAssetLabel } from "@sdp/types/payment-rails";
import type {
  PaymentOfframpQuoteRequest,
  PaymentTransferSummary,
  RampCryptoDeposit,
} from "@sdp/types/payments";
import { address } from "@solana/kit";
import { BanknoteIcon, DollarSignIcon, WalletIcon } from "lucide-react";
import { useMemo } from "react";
import useSWR from "swr";
import useSWRMutation from "swr/mutation";
import { paymentsQueryKeys } from "@/app/dashboard/[projectId]/payments/payments-query-key";
import {
  type CreateTransferInput,
  createTransfer,
  fetchTransferById,
} from "@/app/dashboard/[projectId]/payments/payments-workspace.data";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import type { TranslationValues } from "@/i18n/translate";
import { offrampPairs } from "@/lib/ramps";
import type { WizardSummaryDetail } from "../../wizard-summary-list";
import { submitOfframpDeposit } from "../offramp-deposit";
import { getRampTransferState } from "../ramp-transfer-state";
import { sourceWalletSchema, withdrawAmountSchema, withdrawSelectionSchema } from "../schema";
import {
  memoSummaryDetails,
  optionalDetail,
  providerSummaryDetail,
  summaryAmount,
} from "../wizard-summary";
import { type RampWizardStep, type UseRampWizardProps, useRampWizard } from "./use-ramp-wizard";

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
  const {
    trigger: triggerCreateTransfer,
    data: onchainSendResult,
    isMutating: onchainSendLoading,
    reset: resetCreateTransfer,
  } = useSWRMutation(
    paymentsQueryKeys.createTransfer(),
    // The quote's `transferId` names the row, so a resend is already the same
    // transfer; no Idempotency-Key is needed to keep it from moving twice.
    (_key, { arg }: { arg: CreateTransferInput }) => createTransfer(arg, t, null)
  );

  const wizard = useRampWizard<OfframpStepId>(props, {
    pairs: offrampPairs(sdpEnvironment, props.enabledRampProviders),
    steps: getOfframpSteps(t),
    stepSchemas: { WALLET: sourceWalletSchema, WITHDRAW: withdrawAmountSchema },
    quoteStepId: "MEMO",
    memoStepId: "MEMO",
    requirements: {
      step: getOfframpRequirementsStep(t),
      insertAfter: "WITHDRAW",
      direction: "offramp",
    },
    selectionSchema: withdrawSelectionSchema,
    quoteEndpoint: "/api/dashboard/payments/ramps/offramp/quote",
    buildQuotePayload: ({
      fields,
      selectedWallet,
      provider,
      selectedRampPair,
      assetRail,
      rampsMemo,
    }) =>
      ({
        counterpartyId: fields.counterpartyId,
        sourceCustodyWalletId: selectedWallet.id,
        assetRail,
        cryptoAmount: fields.amount.trim(),
        rampsMemo,
        provider,
        fiatCurrency: selectedRampPair.fiatCurrency,
      }) satisfies PaymentOfframpQuoteRequest,
    onQuoteCreated: () => {
      resetCreateTransfer();
    },
  });

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

  // The hosted provider can report a deposit address while payment is pending.
  const depositTarget = useMemo((): RampCryptoDeposit | null => {
    const quote = wizard.quote;
    if (quote?.deliveryMode === "hosted" && transferStatus?.status === "awaiting_payment") {
      return transferStatus.cryptoDeposit ?? null;
    }
    return null;
  }, [wizard.quote, transferStatus]);

  const offrampCryptoToken = getCryptoRailAssetLabel(wizard.selectedRampPair.assetRail);
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
  const signingUnavailable =
    !!wizard.fields.walletId && wizard.selectedWallet?.isRuntimeExecutionAllowed !== true;
  const canSendOnchain =
    hasCryptoDepositInstruction &&
    !signingUnavailable &&
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
      signingUnavailable ||
      !transferId
    ) {
      return;
    }
    if (onchainSendLoading || onchainSendResult) {
      return;
    }

    await submitOfframpDeposit(
      {
        transferId,
        sourceCustodyWalletId: wizard.selectedWallet.id,
        destination: depositTarget.destinationAddress,
        token: address(sourceTokenMint),
        amount: depositTarget.amount,
      },
      triggerCreateTransfer,
      t
    );
  };

  return {
    ...wizard,
    sourceWalletHint:
      signingUnavailable && !onchainSendResult ? t("DashboardPayments.signingUnavailable") : null,
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
  };
}

export type OfframpWizard = ReturnType<typeof useOfframpWizard>;
