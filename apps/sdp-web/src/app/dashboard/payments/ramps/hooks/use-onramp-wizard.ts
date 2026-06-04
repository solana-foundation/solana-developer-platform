"use client";

import { useState } from "react";
import { toast } from "sonner";
import { simulateSandboxTransfer } from "@/app/dashboard/payments/payments-workspace.data";
import { ONRAMP_PAIRS } from "@/lib/ramps";
import { depositAmountSchema, depositSelectionSchema } from "../schema";
import { type RampWizardStep, type UseRampWizardProps, useRampWizard } from "./use-ramp-wizard";

export const ONRAMP_STEPS = [
  { id: "DEPOSIT", label: "Deposit", title: "How much would you like to deposit?" },
  { id: "PROVIDER", label: "Provider", title: "Complete your deposit" },
  { id: "DONE", label: "Step 4", title: "Coming soon" },
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

  const simulateCurrentQuote = async () => {
    if (wizard.quote?.provider !== "lightspark") {
      return;
    }

    setQuoteSimulationLoading(true);
    const toastId = toast.loading("Simulating quote funding.", { position: "bottom-right" });

    try {
      await simulateSandboxTransfer({
        provider: "lightspark",
        payload: { quoteId: wizard.quote.id, currencyCode: "USD" },
      });
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
    quoteSimulationLoading,
    quoteSimulationSucceeded,
    simulateCurrentQuote,
  };
}

export type OnrampWizard = ReturnType<typeof useOnrampWizard>;
