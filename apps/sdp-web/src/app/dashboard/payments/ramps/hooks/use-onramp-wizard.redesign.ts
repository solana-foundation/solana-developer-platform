"use client";

import {
  getCryptoRailAssetLabel,
  isMuralSandboxPayinCurrency,
  type PaymentOnrampQuoteRequest,
  type PaymentRampQuote,
  type PaymentTransferSummary,
} from "@sdp/types";
import { CoinsIcon, DollarSignIcon, WalletIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import { paymentsQueryKeys } from "@/app/dashboard/payments/payments-query-key";
import {
  fetchTransferById,
  simulateSandboxTransfer,
} from "@/app/dashboard/payments/payments-workspace.data";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import { useLocale, useTranslations } from "@/i18n/provider";
import { demoRampPairs } from "@/lib/payments-demo/demo-ramp-assets";
import { usePaymentsDemo } from "@/lib/payments-demo/payments-demo-context";
import { onrampPairs } from "@/lib/ramps";
import type { WizardSummaryDetail } from "../../wizard-summary-list";
import { getRampTransferState } from "../ramp-transfer-state";
import { depositDetailsSchema, depositSelectionSchema } from "../schema";
import {
  memoSummaryDetails,
  optionalDetail,
  providerSummaryDetail,
  summaryAmount,
} from "../wizard-summary";
import {
  type RampWizardStep,
  type UseRampWizardProps,
  useRampWizard,
} from "./use-ramp-wizard.redesign";

type Translate = (key: MessageKey, values?: TranslationValues) => string;
export type OnrampStepId = "DEPOSIT" | "MEMO" | "REVIEW" | "PROVIDER" | "REQUIREMENTS";

/**
 * Details (contact, amount, wallet, provider), what the provider needs (memo, plus the
 * requirements step when the provider asks for more), a review built from the chosen
 * provider's estimate, and completion. Nothing is persisted before completion: the quote, and
 * the transfer it records, are created when the wizard lands on the last step.
 */
export function getOnrampSteps(t: Translate): readonly RampWizardStep<OnrampStepId>[] {
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

/**
 * Whether the provider's sandbox can simulate this quote's pay-in: Lightspark's always, BVNK's
 * once its funding account is ready, Mural's in the currencies its sandbox pays in.
 */
function canSimulateQuote(quote: PaymentRampQuote, fiatCurrency: string): boolean {
  switch (quote.provider) {
    case "lightspark":
      return true;
    case "bvnk":
      return (
        quote.deliveryMode === "manual_instructions" &&
        quote.paymentInstructions.some(
          (instruction) =>
            instruction.kind === "fiat_funding" && instruction.onboardingStatus === "ready"
        )
      );
    case "mural":
      return isMuralSandboxPayinCurrency(fiatCurrency);
    default:
      return false;
  }
}

interface SimulationContext {
  quote: PaymentRampQuote | null;
  transferId: string | null;
  transferStatus: PaymentTransferSummary | undefined;
  succeeded: boolean;
  demo: boolean;
  sandbox: boolean;
  fiatCurrency: string;
}

/**
 * Whether a deposit can be marked paid: while it waits for its money (and as done until it
 * finishes), through a sandbox provider's own simulation, or in demo mode for any provider, the
 * demo standing in for checkouts that would open elsewhere. A production deposit never offers
 * it: the sandbox can't fund a live deposit.
 */
function simulationOffered(context: SimulationContext): context is SimulationContext & {
  quote: PaymentRampQuote;
  transferId: string;
} {
  const { quote, transferId, transferStatus } = context;
  if (quote === null || transferId === null || transferStatus === undefined) return false;
  if (getRampTransferState(transferStatus.status).terminal) return false;
  if (transferStatus.status !== "awaiting_payment" && !context.succeeded) return false;
  return context.demo || (context.sandbox && canSimulateQuote(quote, context.fiatCurrency));
}

export function useOnrampWizard(props: UseRampWizardProps) {
  const { sdpEnvironment } = useDashboardWorkspace();
  const demo = usePaymentsDemo();
  const t = useTranslations();
  const locale = useLocale();
  const [quoteSimulationLoading, setQuoteSimulationLoading] = useState(false);
  const [quoteSimulationSucceeded, setQuoteSimulationSucceeded] = useState(false);

  const wizard = useRampWizard<OnrampStepId>(props, {
    pairs: demoRampPairs(onrampPairs(sdpEnvironment, props.enabledRampProviders), demo),
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
        // Coinbase renders its Apple Pay link on this domain; must match a CDP-verified domain.
        domain: window.location.hostname,
        rampsMemo,
      }) satisfies PaymentOnrampQuoteRequest,
    onQuoteCreated: () => {
      setQuoteSimulationLoading(false);
      setQuoteSimulationSucceeded(false);
    },
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
      refreshInterval: (transfer) =>
        transfer && getRampTransferState(transfer.status).terminal ? 0 : 3000,
      revalidateOnFocus: true,
      dedupingInterval: 0,
    }
  );

  const bvnkSettlementReached =
    transferStatus !== undefined &&
    transferStatus.status === "settling" &&
    transferStatus.settlement !== undefined &&
    transferStatus.settlement.provider === "bvnk";
  const showCompleteScreen =
    bvnkSettlementReached ||
    (transferStatus !== undefined && transferStatus.status === "completed");

  const simulation = {
    quote: wizard.quote,
    transferId: wizard.quoteTransferId,
    transferStatus,
    succeeded: quoteSimulationSucceeded,
    demo,
    sandbox: sdpEnvironment === "sandbox",
    fiatCurrency: wizard.selectedRampPair.fiatCurrency,
  };
  const simulateAvailable = simulationOffered(simulation);

  const simulateCurrentQuote = async () => {
    if (!simulationOffered(simulation) || !wizard.selectedWallet) {
      return;
    }
    const { transferId } = simulation;

    setQuoteSimulationLoading(true);
    const toastId = toast.loading(t("DashboardPayments.ramps.simulatingQuoteFunding"), {
      position: "bottom-right",
    });

    try {
      await simulateSandboxTransfer({ transferId }, t);
      setQuoteSimulationSucceeded(true);
      toast.success(t("DashboardPayments.ramps.quoteFundingSimulated"), {
        id: toastId,
        position: "bottom-right",
      });
    } catch (error) {
      toast.error(t("DashboardPayments.ramps.quoteSimulationFailed"), {
        id: toastId,
        description:
          error instanceof Error
            ? error.message
            : t("DashboardPayments.ramps.sandboxSimulationFailed"),
        position: "bottom-right",
      });
    } finally {
      setQuoteSimulationLoading(false);
    }
  };

  return {
    ...wizard,
    summaryDetails,
    transferStatus,
    transferStatusLoading,
    quoteSimulationLoading,
    quoteSimulationSucceeded,
    simulateAvailable,
    simulateCurrentQuote,
    showCompleteScreen,
  };
}

export type OnrampWizard = ReturnType<typeof useOnrampWizard>;
