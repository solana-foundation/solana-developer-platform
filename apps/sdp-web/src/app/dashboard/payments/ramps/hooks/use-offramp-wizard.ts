"use client";

import type { PaymentTransferSummary } from "@sdp/types";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import {
  createTransfer,
  fetchTransferByProviderReference,
} from "@/app/dashboard/payments/payments-workspace.data";
import { OFFRAMP_PAIRS, toRampCryptoToken } from "@/lib/ramps";
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

const OFFRAMP_REQUIREMENTS_STEP = {
  id: "REQUIREMENTS",
  label: "Payout details",
  title: "Where should we send the payout?",
} as const satisfies RampWizardStep;

export type OfframpStepId =
  | (typeof OFFRAMP_STEPS)[number]["id"]
  | typeof OFFRAMP_REQUIREMENTS_STEP.id;

export function useOfframpWizard(props: UseRampWizardProps) {
  const [onchainSendLoading, setOnchainSendLoading] = useState(false);
  const [onchainSendResult, setOnchainSendResult] = useState<PaymentTransferSummary | null>(null);
  const [quoteExpired, setQuoteExpired] = useState(false);

  const wizard = useRampWizard<OfframpStepId>(props, {
    pairs: OFFRAMP_PAIRS,
    steps: OFFRAMP_STEPS,
    stepSchemas: { WALLET: sourceWalletSchema, WITHDRAW: withdrawAmountSchema },
    quoteStepId: "WITHDRAW",
    requirements: {
      step: OFFRAMP_REQUIREMENTS_STEP,
      insertAfter: "WITHDRAW",
      direction: "offramp",
    },
    advanceRequirementsBeforeQuote: true,
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
    onQuoteCreated: () => {
      setOnchainSendLoading(false);
      setOnchainSendResult(null);
      setQuoteExpired(false);
    },
  });

  const quoteExpiresAt =
    wizard.quote?.provider === "lightspark" && wizard.quote.deliveryMode === "manual_instructions"
      ? wizard.quote.expiresAt
      : undefined;

  useEffect(() => {
    if (!quoteExpiresAt) {
      return;
    }
    const remainingMs = Date.parse(quoteExpiresAt) - Date.now();
    if (!Number.isFinite(remainingMs)) {
      return;
    }
    if (remainingMs <= 0) {
      setQuoteExpired(true);
      return;
    }
    const timeoutId = window.setTimeout(() => setQuoteExpired(true), remainingMs);
    return () => window.clearTimeout(timeoutId);
  }, [quoteExpiresAt]);

  // The Solana deposit address Grid generated for this realtime-funded quote.
  const depositAddress = useMemo(() => {
    const quote = wizard.quote;
    if (quote?.provider !== "lightspark" || quote.deliveryMode !== "manual_instructions") {
      return null;
    }
    const instruction = quote.paymentInstructions?.find(
      (entry) =>
        entry.accountOrWalletInfo.accountType.toUpperCase() === "SOLANA_WALLET" &&
        entry.accountOrWalletInfo.address
    );
    return instruction?.accountOrWalletInfo.address ?? null;
  }, [wizard.quote]);

  const offrampCryptoToken = toRampCryptoToken(wizard.selectedRampPair.assetRail);
  // The transfers API requires the mint address, not the token symbol.
  const sourceTokenMint = useMemo(() => {
    const balance = wizard.selectedWallet?.balances?.find(
      (entry) => entry.token === offrampCryptoToken
    );
    return balance?.mint ?? null;
  }, [wizard.selectedWallet, offrampCryptoToken]);

  const canSendOnchain =
    depositAddress !== null && sourceTokenMint !== null && wizard.fields.walletId.length > 0;

  const sendCryptoToDeposit = async () => {
    if (!depositAddress || !sourceTokenMint || !wizard.fields.walletId) {
      return;
    }
    if (onchainSendLoading || onchainSendResult) {
      return;
    }
    // Re-check the timestamp at call time — the armed timeout only covers renders.
    if (quoteExpiresAt && Date.parse(quoteExpiresAt) <= Date.now()) {
      setQuoteExpired(true);
      toast.error("Quote expired.", {
        description: "Create a new quote to continue the withdrawal.",
        position: "bottom-right",
      });
      return;
    }

    setOnchainSendLoading(true);
    const toastId = toast.loading("Submitting on-chain transfer.", { position: "bottom-right" });

    try {
      const transfer = await createTransfer({
        source: wizard.fields.walletId,
        destination: depositAddress,
        token: sourceTokenMint,
        amount: wizard.fields.amount.trim(),
      });
      setOnchainSendResult(transfer);
      toast.success("Transfer submitted.", {
        id: toastId,
        description: transfer.signature
          ? "Transaction sent successfully."
          : `Status: ${transfer.status}`,
        position: "bottom-right",
      });
    } catch (error) {
      toast.error("Transfer failed.", {
        id: toastId,
        description: error instanceof Error ? error.message : "Transfer failed.",
        position: "bottom-right",
      });
    } finally {
      setOnchainSendLoading(false);
    }
  };

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
    canSendOnchain,
    onchainSendLoading,
    onchainSendResult,
    sendCryptoToDeposit,
    quoteExpired,
  };
}

export type OfframpWizard = ReturnType<typeof useOfframpWizard>;
