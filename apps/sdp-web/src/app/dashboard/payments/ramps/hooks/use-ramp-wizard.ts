"use client";

import type {
  Counterparty,
  PaymentRampQuote,
  PaymentsDashboardWallet,
  RampProviderId,
} from "@sdp/types";
import type { CollectedFieldData, RampDirection } from "@sdp/types/ramp-requirements";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import type { z } from "zod";
import { paymentsQueryKeys } from "@/app/dashboard/payments/payments-query-key";
import {
  type CounterpartiesResult,
  cancelRampTransfer,
  fetchAllCounterparties,
  getApiError,
} from "@/app/dashboard/payments/payments-workspace.data";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import type { RampProviderAccess } from "@/lib/provider-availability";
import {
  DEFAULT_RAMP_PAIR,
  findRampPair,
  type RampPair,
  type SelectedRampPair,
  toRampCryptoToken,
} from "@/lib/ramps";
import { useZodForm } from "@/lib/use-zod-form";
import { type MemoRow, memoRowsToRecord, validateMemoRows } from "../memo";
import { type RampFields, rampSelectionSchema } from "../schema";
import { useCounterpartyRequirements } from "./use-counterparty-requirements";
import { usePaymentsActionWallets } from "./use-payments-action-wallets";

type Translate = (key: MessageKey, values?: TranslationValues) => string;

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
  rampsMemo: Record<string, string>;
}

export interface RampWizardConfig<TId extends string = string> {
  pairs: readonly RampPair[];
  steps: readonly RampWizardStep<TId>[];
  /** Per-step validation gate, keyed by step id. Steps absent here have no gate. */
  stepSchemas: Partial<Record<TId, z.ZodTypeAny>>;
  /** Step at which the quote is created; the wizard then advances to the next step. */
  quoteStepId: TId;
  memoStepId?: TId;
  selectionSchema: z.ZodTypeAny;
  quoteEndpoint: string;
  buildQuotePayload: (args: RampQuotePayloadArgs) => Record<string, unknown>;
  /**
   * Provider-driven requirements flow. The collect step is inserted after
   * `insertAfter` only when the chosen provider reports `status: "collect"`;
   * the quote step advances provider onboarding via POST /requirements, and
   * this hook fires the quote once the lifecycle reaches `ready`.
   */
  requirements: {
    step: RampWizardStep<TId>;
    insertAfter: TId;
    direction: RampDirection;
  };
  onQuoteCreated?: (quote: PaymentRampQuote) => void;
}

async function createRampQuote(
  endpoint: string,
  payload: Record<string, unknown>,
  t: Translate
): Promise<{ quote: PaymentRampQuote; transferId: string }> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = (await response.json().catch(() => ({}))) as {
    data?: { quote?: PaymentRampQuote; transferId?: string };
    error?: { message?: string };
  };

  if (!response.ok) {
    throw new Error(
      getApiError(
        body,
        t("DashboardPayments.ramps.quoteRequestFailedStatus", { status: response.status })
      )
    );
  }

  if (!body.data?.quote || !body.data.transferId) {
    throw new Error(t("DashboardPayments.ramps.quoteResponseMissingDetails"));
  }

  return { quote: body.data.quote, transferId: body.data.transferId };
}

export interface UseRampWizardProps {
  wallets: PaymentsDashboardWallet[];
  walletsError: string | null;
  rampProviderAccess: RampProviderAccess | null;
  counterpartiesResult: CounterpartiesResult;
  selectedCounterparty: Counterparty | null;
  /** Counterparty chosen upstream; seeds the form and is no longer picked in-wizard. */
  initialCounterpartyId: string;
  /** Invoked when the user goes back from the first step. */
  onExit?: () => void;
}

export function useRampWizard<TId extends string>(
  {
    wallets,
    walletsError,
    rampProviderAccess,
    counterpartiesResult,
    selectedCounterparty,
    initialCounterpartyId,
    onExit,
  }: UseRampWizardProps,
  config: RampWizardConfig<TId>
) {
  const router = useRouter();
  const t = useTranslations();

  const [stepIndex, setStepIndex] = useState(0);
  const [selectedRampPair, setSelectedRampPair] = useState<SelectedRampPair>(DEFAULT_RAMP_PAIR);
  const [counterpartyDialogOpen, setCounterpartyDialogOpen] = useState(false);
  const [createdQuote, setCreatedQuote] = useState<{
    quote: PaymentRampQuote;
    transferId: string;
  } | null>(null);
  const quote = createdQuote === null ? null : createdQuote.quote;
  const quoteTransferId = createdQuote === null ? null : createdQuote.transferId;
  const [hostedQuoteLoading, setHostedQuoteLoading] = useState(false);
  const [isCanceling, setIsCanceling] = useState(false);
  const [memoRows, setMemoRows] = useState<MemoRow[]>([]);
  const { values: fields, setField } = useZodForm(rampSelectionSchema, {
    walletId: "",
    amount: "",
    provider: null,
    counterpartyId: initialCounterpartyId,
  });

  const requirementsConfig = config.requirements;
  const requirements = useCounterpartyRequirements({
    counterpartyId: fields.counterpartyId,
    provider: fields.provider,
    direction: requirementsConfig.direction,
    cryptoToken: toRampCryptoToken(selectedRampPair.assetRail),
    fiatCurrency: selectedRampPair.fiatCurrency,
    destinationWallet: fields.walletId,
    // Quote creation is event-driven: it fires the first time onboarding
    // reaches ready (submit response or status poll), never from an effect.
    // `runQuoteCreation` is declared below; the callback only runs after
    // render, when every binding is initialized.
    onReady: () => {
      if (quoteCreationAttempted.current) {
        return;
      }
      quoteCreationAttempted.current = true;
      void runQuoteCreation();
    },
  });

  const { liveWallets, walletsLoading, liveWalletsError } = usePaymentsActionWallets(
    wallets,
    walletsError
  );

  const { mutate: mutateCounterparties } = useSWR(
    paymentsQueryKeys.actionCounterparties(),
    fetchAllCounterparties,
    {
      fallbackData: counterpartiesResult,
    }
  );

  const selectedWallet = useMemo(
    () => liveWallets.find((wallet) => wallet.walletId === fields.walletId) ?? null,
    [liveWallets, fields.walletId]
  );

  const steps = useMemo<readonly RampWizardStep<TId>[]>(() => {
    if (!requirements.needsCollection) {
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
  const isRequirementsStep = currentStepId === requirementsConfig.step.id;
  const quoteStepId: TId = requirements.needsCollection
    ? requirementsConfig.step.id
    : config.quoteStepId;
  const stepSchema = config.stepSchemas[currentStepId];
  const canProceed = useMemo(() => {
    if (isRequirementsStep) {
      return requirements.isComplete;
    }
    // Block leaving the step that precedes the requirements insertion until the
    // requirements answer has resolved AND isn't a blocker (fetch error, or an
    // `unsupported` provider for this counterparty) — otherwise the quote could
    // fire before collected fields exist / for an unsupported counterparty, or
    // the step could appear under the user on retry.
    if (
      requirementsConfig &&
      currentStepId === requirementsConfig.insertAfter &&
      fields.provider !== null &&
      (!requirements.isResolved || requirements.blockReason !== null)
    ) {
      return false;
    }
    if (config.memoStepId !== undefined && currentStepId === config.memoStepId) {
      return validateMemoRows(memoRows).length === 0;
    }
    return stepSchema ? stepSchema.safeParse(fields).success : true;
  }, [
    isRequirementsStep,
    config.memoStepId,
    memoRows,
    requirements.isComplete,
    requirements.isResolved,
    requirements.blockReason,
    requirementsConfig,
    currentStepId,
    fields,
    stepSchema,
  ]);

  const isLastStep = stepIndex === steps.length - 1;

  const createQuoteForCurrentSelection = async (): Promise<{
    quote: PaymentRampQuote;
    transferId: string;
  } | null> => {
    if (!config.selectionSchema.safeParse(fields).success || !fields.provider) {
      return null;
    }
    const created = await createRampQuote(
      config.quoteEndpoint,
      config.buildQuotePayload({
        fields,
        provider: fields.provider,
        selectedRampPair,
        cryptoToken: toRampCryptoToken(selectedRampPair.assetRail),
        collectedData: requirements.collectedData,
        rampsMemo: memoRowsToRecord(memoRows),
      }),
      t
    );
    setCreatedQuote(created);
    return created;
  };

  const refreshQuote = async () => {
    try {
      await createQuoteForCurrentSelection();
    } catch (error) {
      toast.error(t("DashboardPayments.ramps.unableToCreateQuote"), {
        description:
          error instanceof Error ? error.message : t("DashboardPayments.ramps.quoteRequestFailed"),
        position: "bottom-right",
      });
    }
  };

  // Only auto-fire the quote while the user sits on the transaction stage —
  // stepping back to edit selections must not create a quote from mid-edit state.
  // Once per wizard instance, held in local state (never a shared cache: a
  // remounted wizard — cancel and come back — must fire its own quote); the
  // quote POST persists the transfer and the transfer-status poll owns the
  // flow from there. A failed attempt surfaces through quoteCreationError
  // with an explicit retry.
  const [quoteCreationError, setQuoteCreationError] = useState<Error | null>(null);
  const [quoteCreationRetrying, setQuoteCreationRetrying] = useState(false);
  const quoteCreationAttempted = useRef(false);
  const runQuoteCreation = async () => {
    setQuoteCreationRetrying(true);
    try {
      await createQuoteForCurrentSelection();
      setQuoteCreationError(null);
    } catch (error) {
      setQuoteCreationError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      setQuoteCreationRetrying(false);
    }
  };
  const retryQuoteCreation = () => void runQuoteCreation();

  const advanceRequirementsAndProceed = async () => {
    if (!config.selectionSchema.safeParse(fields).success || !fields.provider) {
      return;
    }
    setHostedQuoteLoading(true);
    const toastId = toast.loading(t("DashboardPayments.ramps.settingUpAccount"), {
      position: "bottom-right",
    });
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
            : t("DashboardPayments.ramps.moreDetailsNeeded"),
          { id: toastId, position: "bottom-right" }
        );
        return;
      }
      setStepIndex((current) => current + 1);
      toast.dismiss(toastId);
    } catch (error) {
      setHostedQuoteLoading(false);
      toast.error(t("DashboardPayments.ramps.unableToStartOnboarding"), {
        id: toastId,
        description:
          error instanceof Error
            ? error.message
            : t("DashboardPayments.ramps.requirementsRequestFailed"),
        position: "bottom-right",
      });
    }
  };

  const handlePrimary = async () => {
    if (!canProceed) {
      return;
    }
    if (currentStepId === quoteStepId) {
      await advanceRequirementsAndProceed();
      return;
    }
    if (isLastStep) {
      toast.info(t("DashboardPayments.ramps.nextStepSoon"));
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

  const cancelTransfer = async () => {
    if (!quote) {
      throw new Error(t("DashboardPayments.ramps.cannotCancelWithoutQuote"));
    }
    if (isCanceling) {
      return;
    }
    setIsCanceling(true);
    const toastId = toast.loading(t("DashboardPayments.ramps.cancelingTransaction"), {
      position: "bottom-right",
    });
    try {
      await cancelRampTransfer({ provider: quote.provider, providerReference: quote.id }, t);
      toast.success(t("DashboardPayments.ramps.transactionCanceled"), {
        id: toastId,
        position: "bottom-right",
      });
      finish();
    } catch (error) {
      setIsCanceling(false);
      toast.error(t("DashboardPayments.ramps.unableToCancelTransaction"), {
        id: toastId,
        description:
          error instanceof Error ? error.message : t("DashboardPayments.ramps.cancellationFailed"),
        position: "bottom-right",
      });
    }
  };

  const handleSecondary = () => {
    if (onTransactionStage) {
      void cancelTransfer();
      return;
    }
    if (stepIndex === 0) {
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
    rampProviderAccess,
    selectedCounterparty,
    stepIndex,
    steps,
    currentStepId,
    isLastStep,
    onTransactionStage,
    isCanceling,
    canProceed,
    collectedData: requirements.collectedData,
    setCollectedField: requirements.setField,
    requirementFields: requirements.fields,
    requirementsBlocker: requirements.blockReason,
    liveWallets,
    walletsLoading,
    liveWalletsError,
    selectedWallet,
    selectedRampPair,
    fields,
    setField,
    quote,
    quoteTransferId,
    memoRows,
    setMemoRows,
    refreshQuote,
    quoteCreationError,
    quoteCreationRetrying,
    retryQuoteCreation,
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
