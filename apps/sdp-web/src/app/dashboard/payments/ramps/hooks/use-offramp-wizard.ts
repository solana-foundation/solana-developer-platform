"use client";

import { OFFRAMP_PAIRS } from "@/lib/ramps";
import { payoutCounterpartySchema, withdrawAmountSchema, withdrawSelectionSchema } from "../schema";
import { type RampWizardStep, type UseRampWizardProps, useRampWizard } from "./use-ramp-wizard";

export const OFFRAMP_STEPS = [
  { id: "COUNTERPARTY", label: "Counterparty", title: "Who are you paying out to?" },
  { id: "WITHDRAW", label: "Withdraw", title: "How much would you like to withdraw?" },
  { id: "COMPLETE", label: "Complete", title: "Complete your payout" },
] as const satisfies readonly RampWizardStep[];

export type OfframpStepId = (typeof OFFRAMP_STEPS)[number]["id"];

export function useOfframpWizard(props: UseRampWizardProps) {
  return useRampWizard(props, {
    pairs: OFFRAMP_PAIRS,
    steps: OFFRAMP_STEPS,
    stepSchemas: { COUNTERPARTY: payoutCounterpartySchema, WITHDRAW: withdrawAmountSchema },
    quoteStepId: "WITHDRAW",
    selectionSchema: withdrawSelectionSchema,
    quoteEndpoint: "/api/dashboard/payments/ramps/offramp/quote",
    buildQuotePayload: ({ fields, provider, selectedRampPair, cryptoToken }) => ({
      provider,
      counterpartyId: fields.counterpartyId,
      sourceWallet: fields.walletId,
      cryptoToken,
      fiatCurrency: selectedRampPair.fiatCurrency,
      cryptoAmount: fields.amount.trim(),
      redirectUrl: `${window.location.origin}/dashboard/payments`,
    }),
  });
}

export type OfframpWizard = ReturnType<typeof useOfframpWizard>;
