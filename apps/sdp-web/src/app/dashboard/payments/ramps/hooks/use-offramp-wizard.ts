"use client";

import type { PaymentTransferSummary } from "@sdp/types";
import useSWR from "swr";
import { fetchTransferByProviderReference } from "@/app/dashboard/payments/payments-workspace.data";
import { OFFRAMP_PAIRS } from "@/lib/ramps";
import { sourceWalletSchema, withdrawAmountSchema, withdrawSelectionSchema } from "../schema";
import {
  isTerminalRampTransferStatus,
  type RampWizardStep,
  type UseRampWizardProps,
  useRampWizard,
} from "./use-ramp-wizard";

export const OFFRAMP_STEPS = [
  { id: "WALLET", label: "Wallet", title: "Which wallet are you withdrawing from?" },
  { id: "WITHDRAW", label: "Withdraw", title: "How much would you like to withdraw?" },
  { id: "COMPLETE", label: "Complete", title: "Complete your payout" },
] as const satisfies readonly RampWizardStep[];

export type OfframpStepId = (typeof OFFRAMP_STEPS)[number]["id"];

export function useOfframpWizard(props: UseRampWizardProps) {
  const wizard = useRampWizard(props, {
    pairs: OFFRAMP_PAIRS,
    steps: OFFRAMP_STEPS,
    stepSchemas: { WALLET: sourceWalletSchema, WITHDRAW: withdrawAmountSchema },
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

  const transferStatusKey = wizard.quote
    ? (["offramp-transfer-status", wizard.quote.provider, wizard.quote.id] as const)
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

  return {
    ...wizard,
    transferStatus,
    transferStatusLoading,
  };
}

export type OfframpWizard = ReturnType<typeof useOfframpWizard>;
