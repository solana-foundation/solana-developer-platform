"use client";

import type { PaymentTransferSummary } from "@sdp/types";
import { useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import {
  fetchTransferByProviderReference,
  simulateSandboxTransfer,
} from "@/app/dashboard/payments/payments-workspace.data";
import { ONRAMP_PAIRS, toRampCryptoToken } from "@/lib/ramps";
import { depositAmountSchema, depositSelectionSchema } from "../schema";
import {
  isTerminalRampTransferStatus,
  type RampWizardStep,
  type UseRampWizardProps,
  useRampWizard,
} from "./use-ramp-wizard";

export const ONRAMP_STEPS = [
  { id: "DEPOSIT", label: "Deposit", title: "How much would you like to deposit?" },
  { id: "PROVIDER", label: "Provider", title: "Complete your deposit" },
] as const satisfies readonly RampWizardStep[];

const ONRAMP_REQUIREMENTS_STEP = {
  id: "REQUIREMENTS",
  label: "Details",
  title: "A few details to continue",
} as const satisfies RampWizardStep;

export type OnrampStepId = (typeof ONRAMP_STEPS)[number]["id"] | typeof ONRAMP_REQUIREMENTS_STEP.id;

export function useOnrampWizard(props: UseRampWizardProps) {
  const [quoteSimulationLoading, setQuoteSimulationLoading] = useState(false);
  const [quoteSimulationSucceeded, setQuoteSimulationSucceeded] = useState(false);

  const wizard = useRampWizard<OnrampStepId>(props, {
    pairs: ONRAMP_PAIRS,
    steps: ONRAMP_STEPS,
    stepSchemas: { DEPOSIT: depositAmountSchema },
    quoteStepId: "DEPOSIT",
    requirements: {
      step: ONRAMP_REQUIREMENTS_STEP,
      insertAfter: "DEPOSIT",
      direction: "onramp",
    },
    advanceRequirementsBeforeQuote: true,
    selectionSchema: depositSelectionSchema,
    quoteEndpoint: "/api/dashboard/payments/ramps/onramp/quote",
    buildQuotePayload: ({ fields, provider, selectedRampPair, cryptoToken, collectedData }) => ({
      provider,
      counterpartyId: fields.counterpartyId,
      destinationWallet: fields.walletId,
      cryptoToken,
      fiatCurrency: selectedRampPair.fiatCurrency,
      fiatAmount: fields.amount.trim(),
      redirectUrl: `${window.location.origin}/dashboard/payments`,
      collectedData,
    }),
    onQuoteCreated: () => {
      setQuoteSimulationLoading(false);
      setQuoteSimulationSucceeded(false);
    },
  });

  const onboardingReady = wizard.onboarding?.status === "ready";
  useSWR(
    onboardingReady && !wizard.quote ? "onramp-ready-quote" : null,
    () => wizard.refreshQuote(),
    { refreshInterval: 4000, revalidateOnFocus: false, dedupingInterval: 0 }
  );

  const transferStatusKey = wizard.quote
    ? (["onramp-transfer-status", wizard.quote.provider, wizard.quote.id] as const)
    : null;
  const { data: transferStatus, isValidating: transferStatusLoading } = useSWR(
    transferStatusKey,
    ([, provider, providerReference]): Promise<PaymentTransferSummary | null> =>
      fetchTransferByProviderReference({ provider, providerReference }),
    {
      refreshInterval: (transfer) =>
        transfer && isTerminalRampTransferStatus(transfer.status) ? 0 : 3000,
      revalidateOnFocus: true,
      dedupingInterval: 0,
    }
  );

  const simulateCurrentQuote = async () => {
    const quote = wizard.quote;
    if (quote?.provider !== "lightspark" && quote?.provider !== "bvnk") {
      return;
    }

    setQuoteSimulationLoading(true);
    const toastId = toast.loading("Simulating quote funding.", { position: "bottom-right" });

    try {
      if (quote.provider === "lightspark") {
        await simulateSandboxTransfer({
          provider: "lightspark",
          payload: { quoteId: quote.id, currencyCode: "USD" },
        });
      } else {
        await simulateSandboxTransfer({
          provider: "bvnk",
          payload: {
            counterpartyId: wizard.fields.counterpartyId,
            amount: Number(wizard.fields.amount.trim()),
            fiatCurrency: wizard.selectedRampPair.fiatCurrency,
            cryptoToken: toRampCryptoToken(wizard.selectedRampPair.assetRail),
            destinationWallet: wizard.fields.walletId,
          },
        });
      }
      setQuoteSimulationSucceeded(true);
      toast.success("Quote funding simulated.", { id: toastId, position: "bottom-right" });
    } catch (error) {
      toast.error("Quote simulation failed.", {
        id: toastId,
        description: error instanceof Error ? error.message : "Sandbox simulation failed.",
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
