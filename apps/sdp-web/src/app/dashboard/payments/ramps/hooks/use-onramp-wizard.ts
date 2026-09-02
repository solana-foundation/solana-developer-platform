"use client";

import {
  isMuralSandboxPayinCurrency,
  type PaymentOnrampQuoteRequest,
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
import { onrampPairs, toRampCryptoToken } from "@/lib/ramps";
import type { WizardSummaryDetail } from "../../wizard-summary-list";
import { getRampTransferState } from "../ramp-transfer-state";
import { depositAmountSchema, depositSelectionSchema } from "../schema";
import {
  memoSummaryDetails,
  optionalDetail,
  providerSummaryDetail,
  summaryAmount,
} from "../wizard-summary";
import { type RampWizardStep, type UseRampWizardProps, useRampWizard } from "./use-ramp-wizard";

type Translate = (key: MessageKey, values?: TranslationValues) => string;
export type OnrampStepId = "DEPOSIT" | "MEMO" | "PROVIDER" | "REQUIREMENTS";

export function getOnrampSteps(t: Translate): readonly RampWizardStep<OnrampStepId>[] {
  return [
    {
      id: "DEPOSIT",
      label: t("DashboardPayments.ramps.onrampDepositStep"),
      title: t("DashboardPayments.ramps.onrampDepositTitle"),
    },
    {
      id: "MEMO",
      label: t("DashboardPayments.ramps.rampMemoStep"),
      title: t("DashboardPayments.ramps.rampMemoStepTitle"),
    },
    {
      id: "PROVIDER",
      label: t("DashboardPayments.ramps.provider"),
      title: t("DashboardPayments.ramps.onrampProviderTitle"),
    },
  ];
}

function getOnrampRequirementsStep(t: Translate): RampWizardStep<OnrampStepId> {
  return {
    id: "REQUIREMENTS",
    label: t("DashboardPayments.ramps.detailsStep"),
    title: t("DashboardPayments.ramps.onrampRequirementsTitle"),
  };
}

export function useOnrampWizard(props: UseRampWizardProps) {
  const { sdpEnvironment } = useDashboardWorkspace();
  const t = useTranslations();
  const locale = useLocale();
  const [quoteSimulationLoading, setQuoteSimulationLoading] = useState(false);
  const [quoteSimulationSucceeded, setQuoteSimulationSucceeded] = useState(false);

  const wizard = useRampWizard<OnrampStepId>(props, {
    pairs: onrampPairs(sdpEnvironment),
    steps: getOnrampSteps(t),
    stepSchemas: { DEPOSIT: depositAmountSchema },
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
      cryptoToken,
      rampsMemo,
    }) =>
      ({
        provider,
        counterpartyId: fields.counterpartyId,
        destinationWallet: selectedWallet.walletId,
        cryptoToken,
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
      value: toRampCryptoToken(wizard.selectedRampPair.assetRail),
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

  const simulateCurrentQuote = async () => {
    const quote = wizard.quote;
    if (
      quote?.provider !== "lightspark" &&
      quote?.provider !== "bvnk" &&
      quote?.provider !== "mural"
    ) {
      return;
    }
    if (!wizard.selectedWallet) {
      return;
    }

    setQuoteSimulationLoading(true);
    const toastId = toast.loading(t("DashboardPayments.ramps.simulatingQuoteFunding"), {
      position: "bottom-right",
    });

    try {
      if (quote.provider === "lightspark") {
        await simulateSandboxTransfer(
          {
            provider: "lightspark",
            payload: { quoteId: quote.id, currencyCode: "USD" },
          },
          t
        );
      } else if (quote.provider === "mural") {
        const fiatCurrency = wizard.selectedRampPair.fiatCurrency;
        if (!isMuralSandboxPayinCurrency(fiatCurrency)) {
          throw new Error(
            t("DashboardPayments.ramps.muralSandboxCurrencyUnsupported", {
              currency: fiatCurrency,
            })
          );
        }
        await simulateSandboxTransfer(
          {
            provider: "mural",
            payload: {
              counterpartyId: wizard.fields.counterpartyId,
              amount: Number(wizard.fields.amount.trim()),
              fiatCurrency,
            },
          },
          t
        );
      } else {
        await simulateSandboxTransfer(
          {
            provider: "bvnk",
            payload: {
              counterpartyId: wizard.fields.counterpartyId,
              amount: Number(wizard.fields.amount.trim()),
              fiatCurrency: wizard.selectedRampPair.fiatCurrency,
              cryptoToken: toRampCryptoToken(wizard.selectedRampPair.assetRail),
              destinationWallet: wizard.selectedWallet.walletId,
            },
          },
          t
        );
      }
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
    simulateCurrentQuote,
  };
}

export type OnrampWizard = ReturnType<typeof useOnrampWizard>;
