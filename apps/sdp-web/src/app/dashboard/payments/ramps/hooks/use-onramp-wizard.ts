"use client";

import {
  isMuralSandboxPayinCurrency,
  type PaymentOnrampQuoteRequest,
  type PaymentTransferSummary,
} from "@sdp/types";
import type { CollectedFieldData } from "@sdp/types/ramp-requirements";
import { useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import {
  fetchTransferByProviderReference,
  simulateSandboxTransfer,
} from "@/app/dashboard/payments/payments-workspace.data";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { ONRAMP_PAIRS, toRampCryptoToken } from "@/lib/ramps";
import { depositAmountSchema, depositSelectionSchema } from "../schema";
import {
  isTerminalRampTransferStatus,
  type RampWizardStep,
  type UseRampWizardProps,
  useRampWizard,
} from "./use-ramp-wizard";

type Translate = (key: MessageKey, values?: TranslationValues) => string;
export type OnrampStepId = "DEPOSIT" | "PROVIDER" | "REQUIREMENTS";

export function getOnrampSteps(t: Translate): readonly RampWizardStep<OnrampStepId>[] {
  return [
    {
      id: "DEPOSIT",
      label: t("DashboardPayments.ramps.onrampDepositStep"),
      title: t("DashboardPayments.ramps.onrampDepositTitle"),
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
  const t = useTranslations();
  const [quoteSimulationLoading, setQuoteSimulationLoading] = useState(false);
  const [quoteSimulationSucceeded, setQuoteSimulationSucceeded] = useState(false);

  const wizard = useRampWizard<OnrampStepId>(props, {
    pairs: ONRAMP_PAIRS,
    steps: getOnrampSteps(t),
    stepSchemas: { DEPOSIT: depositAmountSchema },
    quoteStepId: "DEPOSIT",
    requirements: {
      step: getOnrampRequirementsStep(t),
      insertAfter: "DEPOSIT",
      direction: "onramp",
    },
    advanceRequirementsBeforeQuote: true,
    selectionSchema: depositSelectionSchema,
    quoteEndpoint: "/api/dashboard/payments/ramps/onramp/quote",
    buildQuotePayload: ({
      fields,
      provider,
      selectedRampPair,
      cryptoToken,
      collectedData,
      rampsMemo,
    }) =>
      ({
        provider,
        counterpartyId: fields.counterpartyId,
        destinationWallet: fields.walletId,
        cryptoToken,
        fiatCurrency: selectedRampPair.fiatCurrency,
        fiatAmount: fields.amount.trim(),
        redirectUrl: `${window.location.origin}/dashboard/payments`,
        // Coinbase renders its Apple Pay link on this domain; must match a CDP-verified domain.
        domain: window.location.hostname,
        rampsMemo,
        collectedData,
      }) satisfies PaymentOnrampQuoteRequest & { collectedData: CollectedFieldData },
    onQuoteCreated: () => {
      setQuoteSimulationLoading(false);
      setQuoteSimulationSucceeded(false);
    },
  });

  const transferStatusKey = wizard.quote
    ? (["onramp-transfer-status", wizard.quote.provider, wizard.quote.id] as const)
    : null;
  const { data: transferStatus, isValidating: transferStatusLoading } = useSWR(
    transferStatusKey,
    ([, provider, providerReference]): Promise<PaymentTransferSummary | null> =>
      fetchTransferByProviderReference({ provider, providerReference }, t),
    {
      refreshInterval: (transfer) =>
        transfer && isTerminalRampTransferStatus(transfer.status) ? 0 : 3000,
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
              destinationWallet: wizard.fields.walletId,
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
    transferStatus,
    transferStatusLoading,
    quoteSimulationLoading,
    quoteSimulationSucceeded,
    simulateCurrentQuote,
  };
}

export type OnrampWizard = ReturnType<typeof useOnrampWizard>;
