"use client";

import { useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import { simulateSandboxTransfer } from "@/app/dashboard/payments/payments-workspace.data";
import { ONRAMP_PAIRS, toRampCryptoToken } from "@/lib/ramps";
import { depositAmountSchema, depositSelectionSchema } from "../schema";
import { type RampWizardStep, type UseRampWizardProps, useRampWizard } from "./use-ramp-wizard";

export const ONRAMP_STEPS = [
  { id: "DEPOSIT", label: "Deposit", title: "How much would you like to deposit?" },
  { id: "PROVIDER", label: "Provider", title: "Complete your deposit" },
] as const satisfies readonly RampWizardStep[];

export type OnrampStepId = (typeof ONRAMP_STEPS)[number]["id"];

export function useOnrampWizard(props: UseRampWizardProps) {
  const [quoteSimulationLoading, setQuoteSimulationLoading] = useState(false);
  const [quoteSimulationSucceeded, setQuoteSimulationSucceeded] = useState(false);

  const wizard = useRampWizard(props, {
    pairs: ONRAMP_PAIRS,
    steps: ONRAMP_STEPS,
    stepSchemas: { DEPOSIT: depositAmountSchema },
    quoteStepId: "DEPOSIT",
    selectionSchema: depositSelectionSchema,
    quoteEndpoint: "/api/dashboard/payments/ramps/onramp/quote",
    buildQuotePayload: ({ fields, provider, selectedRampPair, cryptoToken }) => ({
      provider,
      counterpartyId: fields.counterpartyId,
      destinationWallet: fields.walletId,
      cryptoToken,
      fiatCurrency: selectedRampPair.fiatCurrency,
      fiatAmount: fields.amount.trim(),
      redirectUrl: `${window.location.origin}/dashboard/payments`,
    }),
    onQuoteCreated: () => {
      setQuoteSimulationLoading(false);
      setQuoteSimulationSucceeded(false);
    },
  });

  const bvnkInstruction =
    wizard.quote?.provider === "bvnk" && wizard.quote.deliveryMode === "manual_instructions"
      ? wizard.quote.paymentInstructions[0]
      : undefined;

  const isAwaitingBvnk =
    bvnkInstruction !== undefined &&
    (bvnkInstruction.onboardingStatus !== "ready" || !bvnkInstruction.bankAccount?.accountNumber);

  useSWR(isAwaitingBvnk ? "bvnk-onramp-verification-poll" : null, () => wizard.refreshQuote(), {
    refreshInterval: 4000,
    revalidateOnFocus: false,
    dedupingInterval: 0,
  });

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
    bvnkInstruction,
    quoteSimulationLoading,
    quoteSimulationSucceeded,
    simulateCurrentQuote,
  };
}

export type OnrampWizard = ReturnType<typeof useOnrampWizard>;
