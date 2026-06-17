"use client";

import type {
  Counterparty,
  PaymentRampQuote,
  PaymentsDashboardWallet,
  RampProviderId,
} from "@sdp/types";
import type { CollectedFieldData, RampDirection } from "@sdp/types/ramp-requirements";
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
import { useCounterpartyRequirements } from "./use-counterparty-requirements";

const PAYMENTS_ACTION_WALLETS_KEY = "payments-action-wallets";
const PAYMENTS_ACTION_COUNTERPARTIES_KEY = "payments-action-counterparties";

export function isTerminalRampTransferStatus(status: string) {
  return status === "completed" || status === "failed" || status === "expired";
}

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
  collectedData: CollectedFieldData;
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
  /**
   * Optional provider-driven step, inserted after `insertAfter` only when the
   * chosen provider reports `status: "collect"` for the counterparty. The quote
   * then fires at this step (carrying `collectedData`) instead of `quoteStepId`.
   */
  requirements?: {
    step: RampWizardStep<TId>;
    insertAfter: TId;
    direction: RampDirection;
  };
  /**
   * When set, the quote step advances provider onboarding via POST /requirements
   * (provisioning) instead of firing the quote; the caller fires the quote once
   * the lifecycle reaches `ready`. Used by on-ramp; off-ramp leaves this unset.
   */
  advanceRequirementsBeforeQuote?: boolean;
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

  const requirementsConfig = config.requirements;
  const requirements = useCounterpartyRequirements(
    requirementsConfig
      ? {
          counterpartyId: fields.counterpartyId,
          provider: fields.provider,
          direction: requirementsConfig.direction,
          // Off-ramp requirements are payout-currency specific (e.g. lightspark bank
          // fields); on-ramp requirements are not, so the key stays currency-free there.
          ...(requirementsConfig.direction === "offramp"
            ? { fiatCurrency: selectedRampPair.fiatCurrency }
            : {}),
        }
      : null
  );

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

  const steps = useMemo<readonly RampWizardStep<TId>[]>(() => {
    if (!requirementsConfig || !requirements.needsCollection) {
      return config.steps;
    }
    const insertIndex = config.steps.findIndex(
      (step) => step.id === requirementsConfig.insertAfter
    );
    return [
      ...config.steps.slice(0, insertIndex + 1),
      requirementsConfig.step,
      ...config.steps.slice(insertIndex + 1),
    ];
  }, [config.steps, requirementsConfig, requirements.needsCollection]);

  const currentStepId = steps[stepIndex].id;
  const isRequirementsStep =
    requirementsConfig !== undefined && currentStepId === requirementsConfig.step.id;
  const quoteStepId: TId =
    requirementsConfig && requirements.needsCollection
      ? requirementsConfig.step.id
      : config.quoteStepId;
  const stepSchema = config.stepSchemas[currentStepId];
  const canProceed = useMemo(() => {
    if (isRequirementsStep) {
      return requirements.isComplete;
    }
    // Block leaving the provider-selection step until the requirements answer has
    // resolved AND isn't a blocker (fetch error, or an `unsupported` provider for
    // this counterparty) — otherwise the quote could fire before collected fields
    // exist / for an unsupported counterparty, or the step could appear under the
    // user on retry.
    if (
      requirementsConfig &&
      currentStepId === requirementsConfig.insertAfter &&
      fields.provider !== null &&
      (!requirements.isResolved || requirements.blockReason !== null)
    ) {
      return false;
    }
    return stepSchema ? stepSchema.safeParse(fields).success : true;
  }, [
    isRequirementsStep,
    requirements.isComplete,
    requirements.isResolved,
    requirements.blockReason,
    requirementsConfig,
    currentStepId,
    fields,
    stepSchema,
  ]);

  const isLastStep = stepIndex === steps.length - 1;

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
          collectedData: requirements.collectedData,
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
          collectedData: requirements.collectedData,
        })
      );
      setQuote(created);
    } catch {}
  };

  const advanceRequirementsAndProceed = async () => {
    if (!config.selectionSchema.safeParse(fields).success || !fields.provider) {
      return;
    }
    setHostedQuoteLoading(true);
    const toastId = toast.loading("Setting up your account.", { position: "bottom-right" });
    try {
      const result = await requirements.submitRequirements({
        cryptoToken: toRampCryptoToken(selectedRampPair.assetRail),
        destinationWallet: fields.walletId,
        fiatCurrency: selectedRampPair.fiatCurrency,
      });
      setHostedQuoteLoading(false);
      if (result.status === "collect" || result.status === "unsupported") {
        toast.error(
          result.status === "unsupported"
            ? result.reason
            : "We need a few more details before continuing.",
          { id: toastId, position: "bottom-right" }
        );
        return;
      }
      setStepIndex((current) => current + 1);
      toast.dismiss(toastId);
    } catch (error) {
      setHostedQuoteLoading(false);
      toast.error("Unable to start onboarding.", {
        id: toastId,
        description: error instanceof Error ? error.message : "Requirements request failed.",
        position: "bottom-right",
      });
    }
  };

  const handlePrimary = async () => {
    if (!canProceed) {
      return;
    }
    if (currentStepId === quoteStepId) {
      if (config.advanceRequirementsBeforeQuote) {
        await advanceRequirementsAndProceed();
      } else {
        await createQuoteAndAdvance();
      }
      return;
    }
    if (isLastStep) {
      toast.info("Next step coming soon.");
      return;
    }
    setStepIndex((current) => current + 1);
  };

  const finish = () => {
    if (onExit) {
      onExit();
      return;
    }
    router.push("/dashboard/payments");
  };

  // Once the quote exists the wizard is on the transaction stage — stepping back
  // into amount/details would orphan the live quote, so back becomes an explicit exit.
  const onTransactionStage = isLastStep && quote !== null;

  const handleSecondary = () => {
    if (stepIndex === 0 || onTransactionStage) {
      finish();
      return;
    }
    setStepIndex((current) => Math.max(0, current - 1));
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
    steps,
    currentStepId,
    isLastStep,
    onTransactionStage,
    canProceed,
    collectedData: requirements.collectedData,
    setCollectedField: requirements.setField,
    requirementFields: requirements.fields,
    requirementsBlocker: requirements.blockReason,
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
    onboarding: requirements.onboarding,
    isAdvancing: requirements.isAdvancing,
    retryOnboarding: requirements.retryOnboarding,
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
