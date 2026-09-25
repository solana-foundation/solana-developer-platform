"use client";

import type {
  Counterparty,
  CryptoRailId,
  PaymentRampQuote,
  PaymentsDashboardWallet,
  RampProviderId,
} from "@sdp/types";
import type {
  CollectedFieldData,
  PayoutRequirementAccount,
  RampDirection,
} from "@sdp/types/ramp-requirements";
import { isCollectStageStatus } from "@sdp/types/ramp-requirements";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import useSWR, { useSWRConfig } from "swr";
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
import { DEFAULT_RAMP_PAIR, findRampPair, type RampPair, type SelectedRampPair } from "@/lib/ramps";
import { useZodForm } from "@/lib/use-zod-form";
import { hasOnboardingLifecycle } from "../components/providers";
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
  selectedWallet: PaymentsDashboardWallet;
  provider: RampProviderId;
  selectedRampPair: SelectedRampPair;
  assetRail: CryptoRailId;
  collectedData: CollectedFieldData;
  selectedProviderAccountId: string | null;
  /** Explicitly picked saved payout account; its corridor overrides the collected destination country. */
  selectedPayoutAccount: PayoutRequirementAccount | null;
  rampsMemo: Record<string, string>;
}

export interface RampWizardConfig<TId extends string = string> {
  pairs: readonly RampPair[];
  steps: readonly RampWizardStep<TId>[];
  /** Per-step validation gate, keyed by step id. Steps absent here have no gate. */
  stepSchemas: Partial<Record<TId, z.ZodTypeAny>>;
  /** Step whose primary action submits the requirements advance (provisioning); the wizard then advances to the next step. */
  quoteStepId: TId;
  memoStepId?: TId;
  selectionSchema: z.ZodTypeAny;
  quoteEndpoint: string;
  buildQuotePayload: (args: RampQuotePayloadArgs) => Record<string, unknown>;
  /**
   * Provider-driven requirements flow. The collect step is inserted after
   * `insertAfter` only when the chosen provider reports `status: "collect"`;
   * the collect (or quote) step advances provider onboarding via POST
   * /requirements. The quote embeds the memo, so it fires only once the user
   * has passed the memo step AND the lifecycle has reached `ready` — whichever
   * of the two happens last triggers it.
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
  idempotencyKey: string | null,
  t: Translate
): Promise<{ quote: PaymentRampQuote; transferId: string }> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(idempotencyKey === null ? {} : { "Idempotency-Key": idempotencyKey }),
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    throw new Error(
      getApiError(
        errorBody,
        t("DashboardPayments.ramps.quoteRequestFailedStatus", { status: response.status })
      )
    );
  }

  const body = (await response.json().catch(() => ({}))) as {
    data?: { quote?: PaymentRampQuote; transferId?: string };
  };
  if (!body.data?.quote || !body.data.transferId) {
    throw new Error(t("DashboardPayments.ramps.quoteResponseMissingDetails"));
  }

  return { quote: body.data.quote, transferId: body.data.transferId };
}

export interface UseRampWizardProps {
  wallets: PaymentsDashboardWallet[];
  walletsError: string | null;
  enabledRampProviders: RampProviderId[];
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
    enabledRampProviders,
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

  const { mutate: mutateSwrCache } = useSWRConfig();
  const selectProvider = (provider: RampProviderId) => {
    void mutateSwrCache(paymentsQueryKeys.isCounterpartyRequirementsKey, undefined, {
      revalidate: true,
    });
    setField("provider", provider);
  };

  const selectedProviderField = fields.provider;
  useEffect(() => {
    if (selectedProviderField === null) return;
    const pair = findRampPair(config.pairs, selectedRampPair);
    if (!pair?.providers.includes(selectedProviderField)) {
      setField("provider", null);
    }
  }, [config.pairs, selectedRampPair, selectedProviderField, setField]);

  const { liveWallets, walletsLoading, liveWalletsError } = usePaymentsActionWallets(
    wallets,
    walletsError
  );

  const selectedWallet = useMemo(
    () => liveWallets.find((wallet) => wallet.id === fields.walletId) ?? null,
    [liveWallets, fields.walletId]
  );

  const requirementsConfig = config.requirements;
  const requirements = useCounterpartyRequirements({
    counterpartyId: fields.counterpartyId,
    provider: fields.provider,
    direction: requirementsConfig.direction,
    assetRail: selectedRampPair.assetRail,
    fiatCurrency: selectedRampPair.fiatCurrency,
    destinationCustodyWalletId: selectedWallet === null ? null : selectedWallet.id,
  });

  const { mutate: mutateCounterparties } = useSWR(
    paymentsQueryKeys.actionCounterparties(),
    fetchAllCounterparties,
    {
      fallbackData: counterpartiesResult,
    }
  );

  // Once inserted, the requirements step is pinned for the provider's lifetime in
  // this wizard: an advance answering `ready` flips needsCollection off, but the
  // step the user is standing on must not vanish under them.
  const [requirementsPin, setRequirementsPin] = useState<{
    provider: RampProviderId | null;
    pinned: boolean;
  }>({ provider: fields.provider, pinned: false });
  if (requirementsPin.provider !== fields.provider) {
    setRequirementsPin({ provider: fields.provider, pinned: false });
  } else if (requirements.needsCollection && !requirementsPin.pinned) {
    setRequirementsPin({ provider: fields.provider, pinned: true });
  }
  const includeRequirementsStep =
    requirements.needsCollection ||
    (requirementsPin.provider === fields.provider && requirementsPin.pinned);

  const steps = useMemo<readonly RampWizardStep<TId>[]>(() => {
    if (!includeRequirementsStep) {
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
  }, [config.steps, requirementsConfig, includeRequirementsStep]);

  const currentStepId = steps[stepIndex].id;
  const isRequirementsStep = currentStepId === requirementsConfig.step.id;
  const quoteStepId: TId = includeRequirementsStep
    ? requirementsConfig.step.id
    : config.quoteStepId;
  const stepSchema = config.stepSchemas[currentStepId];
  const canProceed = useMemo(() => {
    if (isRequirementsStep) {
      return requirements.isComplete && requirements.blockReason === null;
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

  /** The quote request body for the current selection, or null while the
   * selection is not yet a valid committed quote operation. */
  const currentQuotePayload = (
    providerAccountId: string | null
  ): Record<string, unknown> | null => {
    if (!config.selectionSchema.safeParse(fields).success || !fields.provider || !selectedWallet) {
      return null;
    }
    return config.buildQuotePayload({
      fields,
      selectedWallet,
      provider: fields.provider,
      selectedRampPair,
      assetRail: selectedRampPair.assetRail,
      collectedData: requirements.collectedData,
      selectedProviderAccountId: providerAccountId,
      selectedPayoutAccount: requirements.selectedPayoutAccount,
      rampsMemo: memoRowsToRecord(memoRows),
    });
  };

  const createQuoteForCurrentSelection = async (
    providerAccountId: string | null,
    idempotencyKey: string | null
  ): Promise<{
    quote: PaymentRampQuote;
    transferId: string;
  } | null> => {
    const payload = currentQuotePayload(providerAccountId);
    if (payload === null) {
      return null;
    }
    const created = await createRampQuote(config.quoteEndpoint, payload, idempotencyKey, t);
    setCreatedQuote(created);
    return created;
  };

  // One stable operation key per committed quote selection, retained across
  // response loss, a malformed response, and the explicit Try Again: the API
  // replays a keyed quote instead of minting a second provider session and
  // transfer row for the same operation. A deliberate re-quote (an expiring
  // provider session) is a NEW operation and mints a fresh key. The key also
  // rotates when the selection is edited after a failed attempt: the retained
  // key answers only for the payload it minted, and the API conflicts a keyed
  // replay whose fingerprint differs instead of quoting the edited request.
  const quoteOperationKeyRef = useRef<string | null>(null);
  const quoteOperationPayloadRef = useRef<string | null>(null);
  const mintQuoteOperationKey = (serializedPayload: string | null) => {
    const key = `ramp-quote-${crypto.randomUUID()}`;
    quoteOperationKeyRef.current = key;
    quoteOperationPayloadRef.current = serializedPayload;
    return key;
  };

  // Every quote attempt builds its payload against the corridor's
  // provider-resolved payout account — the ready arm resolves it for explicit
  // quote selection — never against the explicitly picked saved-account id:
  // the two differ for a collected-payout flow (nothing is picked), and
  // feeding the retry or re-quote a different source than the initial fire
  // would change the payload without any user edit, so a keyed retry would
  // mint a second quote operation instead of replaying the recorded one. With
  // one account source for every attempt, a payload difference is always a
  // real edit of the selection (amount, wallet, provider, memo, payout
  // account re-resolved by a fresh advance).
  const resolvedProviderAccountId = requirements.resolvedProviderAccountId;

  const refreshQuote = async () => {
    try {
      const payload = currentQuotePayload(resolvedProviderAccountId);
      await createQuoteForCurrentSelection(
        resolvedProviderAccountId,
        mintQuoteOperationKey(payload === null ? null : JSON.stringify(payload))
      );
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
  const runQuoteCreation = async (providerAccountId: string | null) => {
    setQuoteCreationRetrying(true);
    try {
      // A retry of the committed selection reuses the operation key the first
      // attempt minted; an edited selection after a failed attempt is a NEW
      // operation and mints a fresh key, since the API rejects a keyed replay
      // whose fingerprint differs instead of quoting the edited request.
      // Every attempt builds its payload against the same provider-resolved
      // account (see resolvedProviderAccountId above), so the comparison
      // below can only differ when the selection itself changed.
      const payload = currentQuotePayload(providerAccountId);
      if (payload !== null) {
        const serialized = JSON.stringify(payload);
        if (
          quoteOperationKeyRef.current !== null &&
          quoteOperationPayloadRef.current !== serialized
        ) {
          quoteOperationKeyRef.current = null;
        }
        if (quoteOperationKeyRef.current === null) {
          mintQuoteOperationKey(serialized);
        }
      }
      await createQuoteForCurrentSelection(providerAccountId, quoteOperationKeyRef.current);
      setQuoteCreationError(null);
    } catch (error) {
      setQuoteCreationError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      setQuoteCreationRetrying(false);
    }
  };
  const retryQuoteCreation = () => void runQuoteCreation(resolvedProviderAccountId);
  const maybeCreateQuote = (providerAccountId: string | null) => {
    if (quoteCreationAttempted.current) {
      return;
    }
    quoteCreationAttempted.current = true;
    void runQuoteCreation(providerAccountId);
  };

  // Readiness observed by the status poll while the user sits on the transaction
  // stage fires the deferred quote. Readiness is derived corridor-addressed data,
  // so a stale corridor can never reach here; `maybeCreateQuote` still guarantees
  // at most one quote per wizard instance. A genuine network side effect on data
  // arrival — not derived state — hence the effect.
  const onboardingStatus = requirements.onboarding === null ? null : requirements.onboarding.status;
  useEffect(() => {
    if (!isLastStep || onboardingStatus !== "ready") {
      return;
    }
    maybeCreateQuote(resolvedProviderAccountId);
  });

  const advanceRequirementsAndProceed = async () => {
    if (!config.selectionSchema.safeParse(fields).success || !fields.provider || !selectedWallet) {
      return;
    }
    setHostedQuoteLoading(true);
    const toastId = toast.loading(t("DashboardPayments.ramps.settingUpAccount"), {
      position: "bottom-right",
    });
    try {
      const result = await requirements.submitRequirements(
        {
          assetRail: selectedRampPair.assetRail,
          destinationCustodyWalletId: selectedWallet.id,
          fiatCurrency: selectedRampPair.fiatCurrency,
        },
        requirements.pendingAgreements !== null ? "consent" : "collected"
      );
      setHostedQuoteLoading(false);
      if (result.status === "unsupported") {
        toast.error(result.reason, { id: toastId, position: "bottom-right" });
        return;
      }
      if (isCollectStageStatus(result.status)) {
        // Progressive collection: the provider accepted this step and returned
        // the next field set, which the step re-renders in place.
        toast.dismiss(toastId);
        return;
      }
      if (hasOnboardingLifecycle(result.provider) && result.status !== "ready") {
        toast.dismiss(toastId);
        return;
      }
      // Reaching the transaction stage with derived readiness fires the quote
      // through the single readiness effect above.
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
    // Leaving the memo (last input) step lands on the transaction stage; the
    // readiness effect fires the deferred quote there, whether provisioning is
    // already ready or the status poll observes it later.
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
    if (!quote || quoteTransferId === null) {
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
      await cancelRampTransfer({ transferId: quoteTransferId }, t);
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
    enabledRampProviders,
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
    selectedProviderAccountId: requirements.selectedProviderAccountId,
    payoutAccounts: requirements.payoutAccounts,
    selectPayoutAccount: requirements.selectPayoutAccount,
    requirementsBlocker: requirements.blockReason,
    liveWallets,
    walletsLoading,
    liveWalletsError,
    selectedWallet,
    selectedRampPair,
    fields,
    setField,
    selectProvider,
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
    pendingAgreements: requirements.pendingAgreements,
    acceptedAgreements: requirements.acceptedAgreements,
    toggleAgreement: requirements.toggleAgreement,
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
