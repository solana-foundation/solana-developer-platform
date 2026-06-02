"use client";

import type {
  Counterparty,
  PaymentRampQuote,
  PaymentsDashboardWallet,
  RampProviderId,
} from "@sdp/types";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import { DEFAULT_RAMP_PAIR, findRampPair, ONRAMP_PAIRS, type SelectedRampPair } from "@/lib/ramps";
import { useZodForm } from "@/lib/use-zod-form";
import {
  type CounterpartiesResult,
  fetchAllCounterparties,
  fetchWallets,
  getApiError,
  simulateSandboxTransfer,
} from "./payments-workspace.data";
import {
  counterpartySelectionSchema,
  depositAmountSchema,
  depositSelectionSchema,
  INITIAL_ONRAMP_FIELDS,
} from "./ramps/components/schema";

const PAYMENTS_ACTION_WALLETS_KEY = "payments-action-wallets";
const PAYMENTS_ACTION_COUNTERPARTIES_KEY = "payments-action-counterparties";

export const STEPS = [
  { label: "Counterparty", title: "Who is this deposit for?" },
  { label: "Deposit", title: "How much would you like to deposit?" },
  { label: "Provider", title: "Complete your deposit" },
  { label: "Step 4", title: "Coming soon" },
] as const;

const STEP_SCHEMAS = [counterpartySelectionSchema, depositAmountSchema, null, null] as const;

export function toRampCryptoToken(assetRail: SelectedRampPair["assetRail"]): string {
  return assetRail.split(".")[0]?.toUpperCase() ?? assetRail.toUpperCase();
}

async function createOnrampQuote(payload: Record<string, unknown>): Promise<PaymentRampQuote> {
  const response = await fetch("/api/dashboard/payments/ramps/onramp/quote", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = (await response.json().catch(() => ({}))) as {
    data?: { quote?: PaymentRampQuote };
    error?: { message?: string };
  };

  if (!response.ok) {
    throw new Error(getApiError(body, `Ramp quote request failed (${response.status}).`));
  }

  if (!body.data?.quote) {
    throw new Error("Ramp quote response is missing quote details.");
  }

  return body.data.quote;
}

interface UseOnrampWizardProps {
  wallets: PaymentsDashboardWallet[];
  walletsError: string | null;
  enabledRampProviders: RampProviderId[];
  counterpartiesResult: CounterpartiesResult;
}

export function useOnrampWizard({
  wallets,
  walletsError,
  enabledRampProviders,
  counterpartiesResult,
}: UseOnrampWizardProps) {
  const router = useRouter();

  const [stepIndex, setStepIndex] = useState(0);
  const [selectedRampPair, setSelectedRampPair] = useState<SelectedRampPair>(DEFAULT_RAMP_PAIR);
  const [hostedQuoteLoading, setHostedQuoteLoading] = useState(false);
  const [onrampQuote, setOnrampQuote] = useState<PaymentRampQuote | null>(null);
  const [quoteSimulationLoading, setQuoteSimulationLoading] = useState(false);
  const [quoteSimulationSucceeded, setQuoteSimulationSucceeded] = useState(false);
  const [counterpartyDialogOpen, setCounterpartyDialogOpen] = useState(false);
  const form = useZodForm(depositSelectionSchema, INITIAL_ONRAMP_FIELDS);
  const { values: onrampFields, setField } = form;

  const { data: swrWallets, error: walletsFetchError } = useSWR<PaymentsDashboardWallet[]>(
    PAYMENTS_ACTION_WALLETS_KEY,
    () => fetchWallets({ includeBalances: true }),
    {
      fallbackData: wallets.length > 0 ? wallets : undefined,
      revalidateOnFocus: false,
      revalidateIfStale: false,
    }
  );
  const liveWallets = swrWallets ?? wallets;
  const walletsLoading = swrWallets === undefined && !walletsFetchError;
  const liveWalletsError = walletsFetchError
    ? walletsFetchError instanceof Error
      ? walletsFetchError.message
      : "Request failed."
    : swrWallets === undefined
      ? walletsError
      : null;

  const { data: liveCounterpartiesResult, mutate: mutateCounterparties } = useSWR(
    PAYMENTS_ACTION_COUNTERPARTIES_KEY,
    fetchAllCounterparties,
    {
      fallbackData: counterpartiesResult,
      revalidateOnFocus: false,
      revalidateIfStale: false,
    }
  );

  const selectedWallet = useMemo(
    () => liveWallets.find((wallet) => wallet.walletId === onrampFields.walletId) ?? null,
    [liveWallets, onrampFields.walletId]
  );

  const stepSchema = STEP_SCHEMAS[stepIndex];
  const canProceed = useMemo(
    () => (stepSchema ? stepSchema.safeParse(onrampFields).success : true),
    [stepSchema, onrampFields]
  );

  const isLastStep = stepIndex === STEPS.length - 1;
  const currentStep = STEPS[stepIndex];

  const createQuoteAndAdvance = async () => {
    const parsed = depositSelectionSchema.safeParse(onrampFields);
    if (!parsed.success || !onrampFields.provider) {
      return;
    }

    setHostedQuoteLoading(true);
    const toastId = toast.loading("Creating quote.", {
      position: "bottom-right",
    });

    try {
      const quote = await createOnrampQuote({
        provider: onrampFields.provider,
        counterpartyId: onrampFields.counterpartyId,
        destinationWallet: onrampFields.walletId,
        cryptoToken: toRampCryptoToken(selectedRampPair.assetRail),
        fiatCurrency: selectedRampPair.fiatCurrency,
        fiatAmount: onrampFields.amount.trim(),
        redirectUrl: `${window.location.origin}/dashboard/payments`,
      });

      setOnrampQuote(quote);
      setQuoteSimulationLoading(false);
      setQuoteSimulationSucceeded(false);
      setStepIndex(2);
      setHostedQuoteLoading(false);
      toast.success(quote.deliveryMode === "hosted" ? "Widget ready." : "Quote ready.", {
        id: toastId,
        position: "bottom-right",
      });
    } catch (error) {
      setHostedQuoteLoading(false);
      toast.error("Unable to create quote.", {
        id: toastId,
        description: error instanceof Error ? error.message : "Ramp quote request failed.",
        position: "bottom-right",
      });
    }
  };

  const handlePrimary = async () => {
    if (!canProceed) {
      return;
    }
    if (stepIndex === 1) {
      await createQuoteAndAdvance();
      return;
    }
    if (isLastStep) {
      toast.info("Next step coming soon.");
      return;
    }
    setStepIndex((current) => current + 1);
  };

  const handleSecondary = () => {
    if (stepIndex === 0) {
      router.push("/dashboard/payments");
      return;
    }
    setStepIndex((current) => Math.max(0, current - 1));
  };

  const handlePairChange = (nextPair: SelectedRampPair) => {
    setSelectedRampPair(nextPair);
    const support = findRampPair(ONRAMP_PAIRS, nextPair);
    if (onrampFields.provider && !support?.providers.includes(onrampFields.provider)) {
      setField("provider", null);
    }
  };

  const handleCounterpartyCreated = (created: Counterparty) => {
    setField("counterpartyId", created.id);
    void mutateCounterparties(
      (prev) => (prev ? { ...prev, data: [created, ...prev.data] } : { ok: true, data: [created] }),
      { revalidate: true }
    );
    setCounterpartyDialogOpen(false);
  };

  const simulateCurrentQuote = async () => {
    if (onrampQuote?.provider !== "lightspark") {
      return;
    }

    setQuoteSimulationLoading(true);
    const toastId = toast.loading("Simulating quote funding.", {
      position: "bottom-right",
    });

    try {
      await simulateSandboxTransfer({
        provider: "lightspark",
        payload: {
          quoteId: onrampQuote.id,
          currencyCode: "USD",
        },
      });
      setQuoteSimulationSucceeded(true);
      toast.success("Quote funding simulated.", {
        id: toastId,
        position: "bottom-right",
      });
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
    enabledRampProviders,
    stepIndex,
    currentStep,
    isLastStep,
    canProceed,
    liveWallets,
    walletsLoading,
    liveWalletsError,
    liveCounterpartiesResult,
    selectedWallet,
    selectedRampPair,
    onrampFields,
    setField,
    onrampQuote,
    hostedQuoteLoading,
    quoteSimulationLoading,
    quoteSimulationSucceeded,
    counterpartyDialogOpen,
    setCounterpartyDialogOpen,
    handlePrimary,
    handleSecondary,
    handlePairChange,
    handleCounterpartyCreated,
    simulateCurrentQuote,
  };
}

export type OnrampWizard = ReturnType<typeof useOnrampWizard>;
