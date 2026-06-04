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
import type { z } from "zod";
import {
  type CounterpartiesResult,
  fetchAllCounterparties,
  fetchWallets,
  getApiError,
} from "@/app/dashboard/payments/payments-workspace.data";
import {
  DEFAULT_RAMP_PAIR,
  findRampPair,
  type RampPair,
  type SelectedRampPair,
  toRampCryptoToken,
} from "@/lib/ramps";
import { useZodForm } from "@/lib/use-zod-form";
import { type RampFields, rampSelectionSchema } from "../schema";

const PAYMENTS_ACTION_WALLETS_KEY = "payments-action-wallets";
const PAYMENTS_ACTION_COUNTERPARTIES_KEY = "payments-action-counterparties";

export type RampWizardStep<TId extends string = string> = {
  id: TId;
  label: string;
  title: string;
};

export interface RampQuotePayloadArgs {
  fields: RampFields;
  provider: RampProviderId;
  selectedRampPair: SelectedRampPair;
  cryptoToken: string;
}

export interface RampWizardConfig<TId extends string = string> {
  pairs: readonly RampPair[];
  steps: readonly RampWizardStep<TId>[];
  /** Per-step validation gate, keyed by step id. Steps absent here have no gate. */
  stepSchemas: Partial<Record<TId, z.ZodTypeAny>>;
  /** Step at which the quote is created; the wizard then advances to the next step. */
  quoteStepId: TId;
  selectionSchema: z.ZodTypeAny;
  quoteEndpoint: string;
  buildQuotePayload: (args: RampQuotePayloadArgs) => Record<string, unknown>;
  onQuoteCreated?: (quote: PaymentRampQuote) => void;
}

async function createRampQuote(
  endpoint: string,
  payload: Record<string, unknown>
): Promise<PaymentRampQuote> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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

export interface UseRampWizardProps {
  wallets: PaymentsDashboardWallet[];
  walletsError: string | null;
  enabledRampProviders: RampProviderId[];
  counterpartiesResult: CounterpartiesResult;
  /** Counterparty chosen upstream; seeds the form and is no longer picked in-wizard. */
  initialCounterpartyId?: string;
  /** Invoked when the user goes back from the first step. */
  onExit?: () => void;
}

export function useRampWizard<TId extends string>(
  {
    wallets,
    walletsError,
    enabledRampProviders,
    counterpartiesResult,
    initialCounterpartyId = "",
    onExit,
  }: UseRampWizardProps,
  config: RampWizardConfig<TId>
) {
  const router = useRouter();

  const [stepIndex, setStepIndex] = useState(0);
  const [selectedRampPair, setSelectedRampPair] = useState<SelectedRampPair>(DEFAULT_RAMP_PAIR);
  const [counterpartyDialogOpen, setCounterpartyDialogOpen] = useState(false);
  const [quote, setQuote] = useState<PaymentRampQuote | null>(null);
  const [hostedQuoteLoading, setHostedQuoteLoading] = useState(false);
  const { values: fields, setField } = useZodForm(rampSelectionSchema, {
    walletId: "",
    amount: "",
    provider: null,
    counterpartyId: initialCounterpartyId,
  });

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
    () => liveWallets.find((wallet) => wallet.walletId === fields.walletId) ?? null,
    [liveWallets, fields.walletId]
  );

  const currentStepId = config.steps[stepIndex].id;
  const stepSchema = config.stepSchemas[currentStepId];
  const canProceed = useMemo(
    () => (stepSchema ? stepSchema.safeParse(fields).success : true),
    [stepSchema, fields]
  );

  const isLastStep = stepIndex === config.steps.length - 1;

  const createQuoteAndAdvance = async () => {
    if (!config.selectionSchema.safeParse(fields).success || !fields.provider) {
      return;
    }

    setHostedQuoteLoading(true);
    const toastId = toast.loading("Creating quote.", { position: "bottom-right" });

    try {
      const created = await createRampQuote(
        config.quoteEndpoint,
        config.buildQuotePayload({
          fields,
          provider: fields.provider,
          selectedRampPair,
          cryptoToken: toRampCryptoToken(selectedRampPair.assetRail),
        })
      );

      setQuote(created);
      config.onQuoteCreated?.(created);
      setStepIndex((current) => current + 1);
      setHostedQuoteLoading(false);
      toast.success(created.deliveryMode === "hosted" ? "Widget ready." : "Quote ready.", {
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

  const refreshQuote = async () => {
    if (!config.selectionSchema.safeParse(fields).success || !fields.provider) {
      return;
    }
    try {
      const created = await createRampQuote(
        config.quoteEndpoint,
        config.buildQuotePayload({
          fields,
          provider: fields.provider,
          selectedRampPair,
          cryptoToken: toRampCryptoToken(selectedRampPair.assetRail),
        })
      );
      setQuote(created);
    } catch {}
  };

  const handlePrimary = async () => {
    if (!canProceed) {
      return;
    }
    if (currentStepId === config.quoteStepId) {
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
      if (onExit) {
        onExit();
        return;
      }
      router.push("/dashboard/payments");
      return;
    }
    setStepIndex((current) => Math.max(0, current - 1));
  };

  const finish = () => {
    if (onExit) {
      onExit();
      return;
    }
    router.push("/dashboard/payments");
  };

  const handlePairChange = (nextPair: SelectedRampPair) => {
    setSelectedRampPair(nextPair);
    const support = findRampPair(config.pairs, nextPair);
    if (fields.provider && !support?.providers.includes(fields.provider)) {
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

  return {
    enabledRampProviders,
    stepIndex,
    currentStepId,
    isLastStep,
    canProceed,
    liveWallets,
    walletsLoading,
    liveWalletsError,
    liveCounterpartiesResult,
    selectedWallet,
    selectedRampPair,
    fields,
    setField,
    quote,
    refreshQuote,
    hostedQuoteLoading,
    counterpartyDialogOpen,
    setCounterpartyDialogOpen,
    handlePrimary,
    handleSecondary,
    finish,
    handlePairChange,
    handleCounterpartyCreated,
  };
}

export type RampWizard = ReturnType<typeof useRampWizard>;
