"use client";

import { COUNTRIES, isCountryCode, type RampProviderId } from "@sdp/types";
import type { RampFiatCurrency } from "@sdp/types/generated/ramp";
import type {
  CollectedFieldData,
  CounterpartyRequirements,
  PayoutRequirementAccount,
  PayoutRequirementTree,
  RampDirection,
  RequirementField,
  RequirementOption,
} from "@sdp/types/ramp-requirements";
import { useMemo, useState } from "react";
import useSWR from "swr";
import { paymentsQueryKeys } from "@/app/dashboard/payments/payments-query-key";
import { getApiError } from "@/app/dashboard/payments/payments-workspace.data";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { requirementFieldError } from "../schema";

type Translate = (key: MessageKey, values?: TranslationValues) => string;

export interface PayoutRequirementFieldLabels {
  destinationCountry: string;
  paymentRail: string;
}

/**
 * Finds active corridor accounts for a selected destination.
 *
 * @param payout - Provider payout decision tree.
 * @param destinationCountry - Selected destination country code.
 * @returns Active accounts for the destination.
 */
export function activePayoutAccounts(
  payout: PayoutRequirementTree,
  destinationCountry: string
): PayoutRequirementAccount[] {
  return payout.accounts.filter(
    (candidate) =>
      candidate.destinationCountry === destinationCountry &&
      candidate.status.toUpperCase() === "ACTIVE"
  );
}

/**
 * Converts payout country keys into country-name options.
 *
 * @param countryRails - Payout rails grouped by destination country.
 * @returns Country select options in the payout tree's key order.
 */
function payoutCountryOptions(
  countryRails: PayoutRequirementTree["countryRails"]
): RequirementOption[] {
  return Object.entries(countryRails).map(([code, rails]) => {
    if (rails === undefined) {
      throw new Error(`Lightspark payout requirements have no rails for ${code}.`);
    }
    const country = COUNTRIES.find((candidate) => candidate.code === code);
    if (country === undefined) {
      throw new Error(`Lightspark payout requirements have an unknown country ${code}.`);
    }
    return { value: code, label: country.name };
  });
}

/**
 * Reads the rails available for one selected destination country.
 *
 * @param countryRails - Payout rails grouped by destination country.
 * @param destinationCountry - Selected destination country code.
 * @returns The provider-supplied rail options for that country.
 */
function payoutRailsForCountry(
  countryRails: PayoutRequirementTree["countryRails"],
  destinationCountry: string
): RequirementOption[] {
  if (!isCountryCode(destinationCountry)) {
    throw new Error(
      `Lightspark payout requirements have an unknown country ${destinationCountry}.`
    );
  }
  const rails = countryRails[destinationCountry];
  if (rails === undefined) {
    throw new Error(`Lightspark payout requirements have no rails for ${destinationCountry}.`);
  }
  return rails;
}

/**
 * Derives the visible country, rail, and exact bank fields for a payout tree.
 *
 * @param payout - Provider payout decision tree.
 * @param values - Locally collected payout selections.
 * @param labels - Translated labels for synthesized fields.
 * @returns The fields visible for the current local selection.
 */
export function derivePayoutRequirementFields(
  payout: PayoutRequirementTree,
  values: CollectedFieldData,
  labels: PayoutRequirementFieldLabels
): RequirementField[] {
  const destinationCountryField = {
    kind: "select",
    key: "destinationCountry",
    label: labels.destinationCountry,
    required: true,
    options: payoutCountryOptions(payout.countryRails),
  } satisfies Extract<RequirementField, { kind: "select" }>;
  const destinationCountry = values.destinationCountry;
  if (destinationCountry === undefined || destinationCountry.length === 0) {
    return [destinationCountryField];
  }

  const rails = payoutRailsForCountry(payout.countryRails, destinationCountry);
  if (activePayoutAccounts(payout, destinationCountry).length > 0) {
    return [destinationCountryField];
  }

  const paymentRailField = {
    kind: "select",
    key: "paymentRails",
    label: labels.paymentRail,
    required: true,
    options: rails,
  } satisfies Extract<RequirementField, { kind: "select" }>;
  const paymentRail = values.paymentRails;
  if (paymentRail === undefined || paymentRail.length === 0) {
    return [destinationCountryField, paymentRailField];
  }
  if (!rails.some((rail) => rail.value === paymentRail)) {
    return [destinationCountryField, paymentRailField];
  }

  const staticFields = payout.railFields[paymentRail];
  if (staticFields === undefined) {
    throw new Error(`Lightspark payout requirements have no fields for ${paymentRail}.`);
  }
  return [destinationCountryField, paymentRailField, ...staticFields];
}

async function fetchCounterpartyRequirements(
  counterpartyId: string,
  provider: RampProviderId,
  direction: RampDirection,
  corridor: AdvanceRequirementsPayload,
  t: Translate
): Promise<CounterpartyRequirements> {
  const params = new URLSearchParams({
    provider,
    direction,
    cryptoToken: corridor.cryptoToken,
    fiatCurrency: corridor.fiatCurrency,
  });
  if (direction === "onramp") {
    params.set("destinationWallet", corridor.destinationWallet);
  }
  const response = await fetch(
    `/api/dashboard/counterparty/${encodeURIComponent(counterpartyId)}/requirements?${params.toString()}`
  );
  const body = (await response.json().catch(() => ({}))) as {
    data?: CounterpartyRequirements;
    error?: { message?: string };
  };

  if (!response.ok || !body.data) {
    throw new Error(
      getApiError(
        body,
        t("DashboardPayments.workspace.requirementsRequestFailed", { status: response.status })
      )
    );
  }

  return body.data;
}

export interface AdvanceRequirementsPayload {
  cryptoToken: string;
  destinationWallet: string;
  fiatCurrency: RampFiatCurrency;
}

async function advanceCounterpartyRequirements(
  counterpartyId: string,
  provider: RampProviderId,
  direction: RampDirection,
  payload: AdvanceRequirementsPayload & { collectedData: CollectedFieldData },
  t: Translate
): Promise<CounterpartyRequirements> {
  const response = await fetch(
    `/api/dashboard/counterparty/${encodeURIComponent(counterpartyId)}/requirements`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, direction, ...payload }),
    }
  );
  const body = (await response.json().catch(() => ({}))) as {
    data?: CounterpartyRequirements;
    error?: { message?: string };
  };

  if (!response.ok || !body.data) {
    throw new Error(
      getApiError(
        body,
        t("DashboardPayments.workspace.requirementsAdvanceFailed", { status: response.status })
      )
    );
  }

  return body.data;
}

function isOnboardingPending(status: CounterpartyRequirements["status"]): boolean {
  return (
    status === "terms_of_service_required" ||
    status === "customer_verification_required" ||
    status === "customer_verifying" ||
    status === "funding_account_provisioning"
  );
}

/**
 * The corridor fields mirror {@link AdvanceRequirementsPayload}; `destinationWallet`
 * only participates for onramp, where the fetch waits until the user has picked one.
 */
export interface CounterpartyRequirementsParams extends AdvanceRequirementsPayload {
  counterpartyId: string;
  provider: RampProviderId | null;
  direction: RampDirection;
  /** Fires when onboarding reaches `ready` — on submit or when the status poll observes it. */
  onReady?: () => void;
}

export interface CounterpartyRequirementsState {
  /** Fields the client must collect; empty unless the provider returned `collect`. */
  fields: RequirementField[];
  /** Active corridor accounts available for reuse in the selected payout country. */
  existingPayoutAccounts: PayoutRequirementAccount[];
  collectedData: CollectedFieldData;
  setField: (key: string, value: string) => void;
  /** The chosen provider needs fields collected for this counterparty. */
  needsCollection: boolean;
  /** Every required field has a non-empty value. */
  isComplete: boolean;
  /** The requirements answer has loaded — the dynamic-step decision for this provider is known. */
  isResolved: boolean;
  /** Why the user can't proceed past provider selection: a fetch error OR an `unsupported` reason. null when fine. */
  blockReason: string | null;
  /** Live provider onboarding lifecycle from the last advance (POST); null until advanced. */
  onboarding: CounterpartyRequirements | null;
  /** Advances provider provisioning (onramp); resolves to the new lifecycle state. */
  submitRequirements: (payload: AdvanceRequirementsPayload) => Promise<CounterpartyRequirements>;
  /** An advance request is in flight (initial submit or a poll tick). */
  isAdvancing: boolean;
  /** Re-runs the advance (POST) to retry — used by the provisioning_failed "Try again" action. */
  retryOnboarding: () => void;
}

/**
 * Fetches a provider's outstanding counterparty requirements and owns the
 * just-in-time `collectedData` the client fills in. Pass `null` to disable
 * (the wizard always calls this, even for directions/providers with no
 * requirements). Decoupled from the wizard so the step machinery stays generic.
 */
export function useCounterpartyRequirements(
  params: CounterpartyRequirementsParams | null
): CounterpartyRequirementsState {
  const t = useTranslations();
  const [collectedData, setCollectedData] = useState<CollectedFieldData>({});
  const setField = (key: string, value: string) => {
    setCollectedData((previous) => {
      if (key === "destinationCountry" && previous.destinationCountry !== value) {
        return { destinationCountry: value };
      }
      if (key === "paymentRails" && previous.paymentRails !== value) {
        const next: CollectedFieldData = {};
        if (previous.destinationCountry !== undefined) {
          next.destinationCountry = previous.destinationCountry;
        }
        next.paymentRails = value;
        return next;
      }
      return { ...previous, [key]: value };
    });
  };

  // Reset collected answers when the counterparty/provider/currency changes by comparing
  // the previous value during render (React's no-effect way to reset state on a change),
  // so stale KYC or bank details never leak into a different provider's payload.
  const subjectKey =
    params === null ? "" : `${params.counterpartyId}:${params.provider}:${params.fiatCurrency}`;
  const [trackedSubject, setTrackedSubject] = useState(subjectKey);
  const [onboarding, setOnboarding] = useState<CounterpartyRequirements | null>(null);
  const [lastAdvancePayload, setLastAdvancePayload] = useState<AdvanceRequirementsPayload | null>(
    null
  );
  const [isAdvancing, setIsAdvancing] = useState(false);
  if (subjectKey !== trackedSubject) {
    setTrackedSubject(subjectKey);
    setCollectedData({});
    setOnboarding(null);
    setLastAdvancePayload(null);
  }

  const key =
    params?.provider &&
    params.counterpartyId &&
    (params.direction === "offramp" || params.destinationWallet)
      ? ([
          "counterparty-requirements",
          params.counterpartyId,
          params.provider,
          params.direction,
          params.cryptoToken,
          params.fiatCurrency,
          params.direction === "onramp" ? params.destinationWallet : "",
        ] as const)
      : null;
  // Requirements are deterministic for a (counterparty, provider, corridor) for the
  // wizard's lifetime — never revalidate, so `needsCollection` (and thus the wizard's
  // step list) can't flip out from under the user mid-flow.
  const { data, error, mutate } = useSWR(
    key,
    ([, counterpartyId, provider, direction, cryptoToken, fiatCurrency, destinationWallet]) =>
      fetchCounterpartyRequirements(
        counterpartyId,
        provider,
        direction,
        {
          cryptoToken,
          fiatCurrency,
          destinationWallet,
        },
        t
      ),
    { revalidateOnFocus: false, revalidateOnReconnect: false, revalidateIfStale: false }
  );

  const submitRequirements = async (
    payload: AdvanceRequirementsPayload
  ): Promise<CounterpartyRequirements> => {
    if (!params?.provider || !params.counterpartyId) {
      throw new Error(t("DashboardPayments.workspace.requirementsContextMissing"));
    }
    setIsAdvancing(true);
    try {
      const result = await advanceCounterpartyRequirements(
        params.counterpartyId,
        params.provider,
        params.direction,
        { ...payload, collectedData },
        t
      );
      setOnboarding(result);
      setLastAdvancePayload(payload);
      if (
        result.status === "collect" ||
        result.status === "collect_counterparty" ||
        result.status === "collect_account"
      ) {
        await mutate(result, { revalidate: false });
      }
      if (result.status === "ready") {
        params.onReady?.();
      }
      return result;
    } finally {
      setIsAdvancing(false);
    }
  };

  const retryOnboarding = () => {
    if (lastAdvancePayload) {
      void submitRequirements(lastAdvancePayload).catch(() => {});
    }
  };

  useSWR(
    onboarding && lastAdvancePayload && params?.provider && isOnboardingPending(onboarding.status)
      ? paymentsQueryKeys.requirementsStatusPoll({ subjectKey })
      : null,
    async () => {
      if (!lastAdvancePayload || !params?.provider) {
        return;
      }
      const result = await fetchCounterpartyRequirements(
        params.counterpartyId,
        params.provider,
        params.direction,
        lastAdvancePayload,
        t
      );
      setOnboarding(result);
      if (result.status === "ready") {
        params.onReady?.();
      }
    },
    { refreshInterval: 4000, revalidateOnFocus: false, dedupingInterval: 0 }
  );

  const payoutLabels = useMemo<PayoutRequirementFieldLabels>(
    () => ({
      destinationCountry: t("DashboardPayments.ramps.destinationCountry"),
      paymentRail: t("DashboardPayments.ramps.paymentRail"),
    }),
    [t]
  );
  const payout = data !== undefined && data.status === "collect_account" ? data.payout : null;
  const fields = useMemo<RequirementField[]>(() => {
    if (payout !== null) {
      return derivePayoutRequirementFields(payout, collectedData, payoutLabels);
    }
    if (
      data !== undefined &&
      (data.status === "collect" || data.status === "collect_counterparty")
    ) {
      return data.fields;
    }
    return [];
  }, [collectedData, data, payout, payoutLabels]);

  const existingPayoutAccounts = useMemo(
    () =>
      payout === null || collectedData.destinationCountry === undefined
        ? []
        : activePayoutAccounts(payout, collectedData.destinationCountry),
    [collectedData.destinationCountry, payout]
  );

  const isComplete = useMemo(
    () =>
      fields
        .flatMap((field) => (field.kind === "address" ? field.fields : [field]))
        .every((field) => requirementFieldError(field, collectedData[field.key]) === null),
    [fields, collectedData]
  );

  // Every status the provider can return is handled: "collect" → needsCollection,
  // "ready" → proceed, "unsupported" → block with its reason, plus fetch errors.
  let blockReason: string | null = null;
  if (error instanceof Error) {
    blockReason = error.message;
  } else if (data?.status === "unsupported") {
    blockReason = data.reason;
  }

  return {
    fields,
    existingPayoutAccounts,
    collectedData,
    setField,
    needsCollection:
      data?.status === "collect" ||
      data?.status === "collect_counterparty" ||
      data?.status === "collect_account",
    isComplete,
    isResolved: data !== undefined,
    blockReason,
    onboarding,
    submitRequirements,
    isAdvancing,
    retryOnboarding,
  };
}
