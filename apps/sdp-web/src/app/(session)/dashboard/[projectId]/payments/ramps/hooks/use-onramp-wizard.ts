"use client";

import { getCryptoRailAssetLabel } from "@sdp/types/payment-rails";
import type { PaymentOnrampQuoteRequest, PaymentTransferSummary } from "@sdp/types/payments";
import { CoinsIcon, DollarSignIcon, WalletIcon } from "lucide-react";
import useSWR from "swr";
import { paymentsQueryKeys } from "@/app/(session)/dashboard/[projectId]/payments/payments-query-key";
import { fetchTransferById } from "@/app/(session)/dashboard/[projectId]/payments/payments-workspace.data";
import { rampTransferPollInterval } from "@/app/(session)/dashboard/[projectId]/payments/ramps/ramp-phase";
import {
  depositDetailsSchema,
  depositSelectionSchema,
} from "@/app/(session)/dashboard/[projectId]/payments/ramps/schema";
import {
  memoSummaryDetails,
  optionalDetail,
  providerSummaryDetail,
  summaryAmount,
} from "@/app/(session)/dashboard/[projectId]/payments/ramps/wizard-summary";
import type { WizardSummaryDetail } from "@/app/(session)/dashboard/[projectId]/payments/wizard-summary-list";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import type { MessageKey } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import type { TranslationValues } from "@/i18n/translate";
import { onrampPairs } from "@/lib/ramps";
import { type RampWizardStep, type UseRampWizardProps, useRampWizard } from "./use-ramp-wizard";

type Translate = (key: MessageKey, values?: TranslationValues) => string;
export type OnrampStepId = "DEPOSIT" | "MEMO" | "REVIEW" | "PROVIDER" | "REQUIREMENTS";

/**
 * Details (contact, amount, wallet, provider), what the provider needs (memo, plus the
 * requirements step when the provider asks for more), a review built from the chosen
 * provider's estimate, and completion. Nothing is persisted before completion: the quote, and
 * the transfer it records, are created when the wizard lands on the last step.
 */
function getOnrampSteps(t: Translate): readonly RampWizardStep<OnrampStepId>[] {
  return [
    { id: "DEPOSIT", label: t("DashboardPayments.onchainSend.details"), title: "" },
    {
      id: "MEMO",
      label: t("DashboardPayments.ramps.providerDetailsStep"),
      title: t("DashboardPayments.ramps.rampMemoStepTitle"),
    },
    {
      id: "REVIEW",
      label: t("DashboardPayments.onchainSend.review"),
      title: t("DashboardPayments.ramps.reviewBeforeContinue"),
    },
    {
      id: "PROVIDER",
      label: t("DashboardPayments.ramps.completeStep"),
      title: t("DashboardPayments.ramps.onrampProviderTitle"),
    },
  ];
}

function getOnrampRequirementsStep(t: Translate): RampWizardStep<OnrampStepId> {
  return {
    id: "REQUIREMENTS",
    label: t("DashboardPayments.ramps.providerDetailsStep"),
    title: t("DashboardPayments.ramps.onrampRequirementsTitle"),
  };
}

export function useOnrampWizard(props: UseRampWizardProps) {
  const { sdpEnvironment } = useDashboardWorkspace();
  const t = useTranslations();
  const locale = useLocale();

  const wizard = useRampWizard<OnrampStepId>(props, {
    pairs: onrampPairs(sdpEnvironment, props.enabledRampProviders),
    steps: getOnrampSteps(t),
    stepSchemas: { DEPOSIT: depositDetailsSchema },
    quoteStepId: "MEMO",
    memoStepId: "MEMO",
    requirements: {
      step: getOnrampRequirementsStep(t),
      insertAfter: "DEPOSIT",
      direction: "onramp",
    },
    selectionSchema: depositSelectionSchema,
    quoteEndpoint: "/api/dashboard/payments/ramps/onramp/quote",
    buildQuotePayload: ({
      fields,
      selectedWallet,
      provider,
      selectedRampPair,
      assetRail,
      rampsMemo,
    }) =>
      ({
        provider,
        counterpartyId: fields.counterpartyId,
        destinationCustodyWalletId: selectedWallet.id,
        assetRail,
        fiatCurrency: selectedRampPair.fiatCurrency,
        fiatAmount: fields.amount.trim(),
        rampsMemo,
      }) satisfies PaymentOnrampQuoteRequest,
  });

  const amount = summaryAmount(wizard.fields.amount, locale);
  const summaryDetails: WizardSummaryDetail[] = [
    ...optionalDetail(
      wizard.selectedWallet === null ? null : wizard.selectedWallet.label,
      t("DashboardPayments.ramps.destinationWallet"),
      WalletIcon
    ),
    ...optionalDetail(
      amount === null ? null : `${amount} ${wizard.selectedRampPair.fiatCurrency}`,
      t("DashboardPayments.ramps.amount"),
      DollarSignIcon
    ),
    {
      icon: CoinsIcon,
      label: t("DashboardPayments.onchainReceive.receive"),
      value: getCryptoRailAssetLabel(wizard.selectedRampPair.assetRail),
    },
    ...providerSummaryDetail(t, wizard.fields.provider),
    ...memoSummaryDetails(t, wizard.memoRows),
  ];

  const transferStatusKey = wizard.quoteTransferId
    ? paymentsQueryKeys.onrampTransferStatus({ transferId: wizard.quoteTransferId })
    : null;
  const { data: transferStatus, isValidating: transferStatusLoading } = useSWR(
    transferStatusKey,
    ([, transferId]): Promise<PaymentTransferSummary> => fetchTransferById({ transferId }, t),
    {
      // A fresh function each render re-arms SWR's timer with the latest transfer.
      refreshInterval: (transfer) => rampTransferPollInterval(transfer),
      // The interval keeps it current; a focus read on top only doubles the calls.
      revalidateOnFocus: false,
      dedupingInterval: 2_000,
    }
  );

  const showCompleteScreen = transferStatus?.status === "completed";

  return {
    ...wizard,
    summaryDetails,
    transferStatus,
    transferStatusLoading,
    showCompleteScreen,
  };
}

export type OnrampWizard = ReturnType<typeof useOnrampWizard>;
