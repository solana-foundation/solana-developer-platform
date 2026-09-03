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
 * Filters the payout tree's accounts to the ones currently payable.
 *
 * @param payout - Provider payout decision tree.
 * @returns Every active account across all destination countries.
 */
export function activePayoutAccounts(payout: PayoutRequirementTree): PayoutRequirementAccount[] {
  return payout.accounts.filter((candidate) => candidate.status.toUpperCase() === "ACTIVE");
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
  payload: AdvanceRequirementsPayload & {
    collectedData: CollectedFieldData;
    providerAccountId?: string;
  },
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

/**
 * A completed advance addressed by the corridor it answered for. `advanceId`
 * is globally unique, making each advance a distinct polling subject: no
 * earlier advance's poll cache can ever answer for a later one — including
 * across a subject round trip, where any counter would restart and collide.
 */
interface AdvanceRecord {
  corridor: string;
  advanceId: string;
  payload: AdvanceRequirementsPayload;
  result: CounterpartyRequirements;
}

/**
 * Whether a requirements status is a collect stage — an answer that supersedes
 * the initial GET subject-wide (the stage a counterparty has reached with the
 * provider, independent of the collected destination country).
 *
 * @param status - Requirements lifecycle status to classify.
 * @returns True for the collect-stage statuses.
 */
function isCollectStage(status: CounterpartyRequirements["status"]): boolean {
  return status === "collect" || status === "collect_counterparty" || status === "collect_account";
}

type LightsparkOfframpReady = Extract<
  CounterpartyRequirements,
  { provider: "lightspark"; direction: "offramp"; status: "ready" }
>;

/**
 * Narrows a requirements answer to the Lightspark offramp ready arm — the only
 * arm carrying a resolved payout account.
 *
 * @param answer - Requirements answer to narrow.
 * @returns The ready answer, or null for any other arm.
 */
function lightsparkOfframpReadyAnswer(
  answer: CounterpartyRequirements | null | undefined
): LightsparkOfframpReady | null {
  if (answer === null || answer === undefined) {
    return null;
  }
  return answer.provider === "lightspark" &&
    answer.direction === "offramp" &&
    answer.status === "ready"
    ? answer
    : null;
}

/**
 * Reads the payout tree off a requirements answer.
 *
 * @param answer - Requirements answer to inspect.
 * @returns The payout tree, or null when the answer carries none.
 */
function payoutTreeOf(answer: CounterpartyRequirements | undefined): PayoutRequirementTree | null {
  return answer !== undefined && answer.status === "collect_account" ? answer.payout : null;
}

function isOnboardingPending(status: CounterpartyRequirements["status"]): boolean {
  return (
    status === "terms_of_service_required" ||
    status === "customer_pending_agreement_acceptance" ||
    status === "customer_verification_required" ||
    status === "customer_verifying" ||
    status === "customer_funding_account_provisioning" ||
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
}

export interface CounterpartyRequirementsState {
  /** Fields the client must collect; empty unless the provider returned `collect`. */
  fields: RequirementField[];
  /** Id of the explicitly picked account, sent on advances and the quote; never seeded. */
  selectedProviderAccountId: string | null;
  /** Tree entry of the explicitly picked account — carries the corridor the quote pays into. */
  selectedPayoutAccount: PayoutRequirementAccount | null;
  /** Every active saved payout account, across all destination countries. */
  payoutAccounts: PayoutRequirementAccount[];
  /** Picks a saved account, or clears the choice with null; independent of the collection form. */
  selectPayoutAccount: (account: PayoutRequirementAccount | null) => void;
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
  /**
   * Live onboarding lifecycle for the CURRENT corridor, derived from the last
   * advance and its status poll; null until advanced or after a corridor change.
   */
  onboarding: CounterpartyRequirements | null;
  /**
   * The payout account a `ready` onboarding resolved for the current corridor;
   * null otherwise.
   */
  resolvedProviderAccountId: string | null;
  /** Advances provider provisioning; resolves to the new lifecycle state. */
  submitRequirements: (payload: AdvanceRequirementsPayload) => Promise<CounterpartyRequirements>;
  /** An advance POST is in flight. */
  isAdvancing: boolean;
  /** Re-runs the advance (POST) to retry — used by the customer funding provisioning failure action. */
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
  const [selectedPayoutAccountId, setSelectedPayoutAccountId] = useState<string | null>(null);
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
  const selectPayoutAccount = (account: PayoutRequirementAccount | null) => {
    setSelectedPayoutAccountId(account === null ? null : account.id);
  };

  // Reset collected answers when any request-corridor field changes by comparing
  // the previous value during render (React's no-effect way to reset state on a change),
  // so stale KYC or bank details never leak into a different corridor's payload and a
  // pending onboarding never survives into one.
  const subjectKey =
    params === null
      ? ""
      : `${params.counterpartyId}:${params.provider}:${params.direction}:${params.cryptoToken}:${params.fiatCurrency}:${params.destinationWallet}`;
  const [trackedSubject, setTrackedSubject] = useState(subjectKey);
  // The completed advance, tagged with the corridor it answered for. Responses
  // are data addressed by their corridor, never commands: a write from a
  // continuation that raced a corridor change is inert because every read
  // filters on the CURRENT corridor identity — no application-time guards.
  const [advanceRecord, setAdvanceRecord] = useState<AdvanceRecord | null>(null);
  const [collectRecord, setCollectRecord] = useState<{
    subject: string;
    result: CounterpartyRequirements;
  } | null>(null);
  const [isAdvancing, setIsAdvancing] = useState(false);
  // The request subject plus the routing choice living outside the subject key —
  // the collected destination country and the explicitly picked account: together
  // the full submission an advance or poll response answers for.
  const corridorIdentity = `${subjectKey}:${
    collectedData.destinationCountry === undefined ? "" : collectedData.destinationCountry
  }:${selectedPayoutAccountId === null ? "" : selectedPayoutAccountId}`;
  if (subjectKey !== trackedSubject) {
    setTrackedSubject(subjectKey);
    setCollectedData({});
    setSelectedPayoutAccountId(null);
    setAdvanceRecord(null);
    setCollectRecord(null);
  }
  const advance =
    advanceRecord !== null && advanceRecord.corridor === corridorIdentity ? advanceRecord : null;

  const key =
    params?.provider &&
    params.counterpartyId &&
    (params.direction === "offramp" || params.destinationWallet)
      ? paymentsQueryKeys.counterpartyRequirements({
          counterpartyId: params.counterpartyId,
          provider: params.provider,
          direction: params.direction,
          cryptoToken: params.cryptoToken,
          fiatCurrency: params.fiatCurrency,
          destinationWallet: params.direction === "onramp" ? params.destinationWallet : "",
        })
      : null;
  // Requirements never revalidate on their own — `needsCollection` (and thus the
  // wizard's step list) can't flip out from under the user mid-flow.
  const {
    data,
    error,
    mutate: revalidateRequirements,
  } = useSWR(
    key,
    ([, counterpartyId, provider, direction, cryptoToken, fiatCurrency, destinationWallet]) =>
      fetchCounterpartyRequirements(
        counterpartyId,
        provider,
        direction,
        { cryptoToken, fiatCurrency, destinationWallet },
        t
      ),
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      revalidateIfStale: false,
    }
  );

  const submitRequirements = async (
    payload: AdvanceRequirementsPayload
  ): Promise<CounterpartyRequirements> => {
    if (!params?.provider || !params.counterpartyId) {
      throw new Error(t("DashboardPayments.workspace.requirementsContextMissing"));
    }
    const corridor = corridorIdentity;
    setIsAdvancing(true);
    try {
      const result = await advanceCounterpartyRequirements(
        params.counterpartyId,
        params.provider,
        params.direction,
        selectedPayoutAccount === null
          ? { ...payload, collectedData }
          : {
              ...payload,
              collectedData: { destinationCountry: selectedPayoutAccount.destinationCountry },
              providerAccountId: selectedPayoutAccount.id,
            },
        t
      );
      setAdvanceRecord({ corridor, advanceId: crypto.randomUUID(), payload, result });
      if (isCollectStage(result.status)) {
        setCollectRecord({ subject: subjectKey, result });
      }
      return result;
    } finally {
      setIsAdvancing(false);
      // Even a failed advance can have created a payout account (created but
      // not active yet throws) — refetch so the tree carries the fresh list.
      if (params.provider === "lightspark" && params.direction === "offramp") {
        void revalidateRequirements();
      }
    }
  };

  const retryOnboarding = () => {
    if (advance !== null) {
      void submitRequirements(advance.payload).catch(() => {});
    }
  };

  // The onboarding status poll is a pure data fetch keyed by the corridor the
  // advance answered for: a corridor change changes the key, so a tick that
  // resolves for an abandoned corridor lands in a cache entry nothing reads.
  // Polling stops itself once its own data reports a non-pending status.
  // The advanceId in the key is what guarantees freshness: SWR has no per-hook
  // no-cache or TTL option (https://github.com/vercel/swr/discussions/1642,
  // https://github.com/vercel/swr/discussions/2293) and cache.delete cannot
  // stop an in-flight tick from repopulating a shared key, so no two advances
  // ever share a key.
  const pollKey =
    advance !== null && params?.provider && isOnboardingPending(advance.result.status)
      ? paymentsQueryKeys.requirementsStatusPoll({
          subjectKey: `${corridorIdentity}#${advance.advanceId}`,
        })
      : null;
  const { data: polledOnboarding } = useSWR(
    pollKey,
    () => {
      if (advance === null || !params?.provider) {
        throw new Error(t("DashboardPayments.workspace.requirementsContextMissing"));
      }
      return fetchCounterpartyRequirements(
        params.counterpartyId,
        params.provider,
        params.direction,
        advance.payload,
        t
      );
    },
    {
      refreshInterval: (latest) =>
        latest !== undefined && !isOnboardingPending(latest.status) ? 0 : 4000,
      revalidateOnFocus: false,
      dedupingInterval: 0,
    }
  );

  // The live onboarding lifecycle for the CURRENT corridor: the freshest of the
  // advance response and its status poll. Both sources are corridor-addressed,
  // so an abandoned corridor's result can never surface here.
  const onboarding =
    advance === null ? null : polledOnboarding !== undefined ? polledOnboarding : advance.result;
  const advanceReady = lightsparkOfframpReadyAnswer(onboarding);
  const resolvedProviderAccountId = advanceReady === null ? null : advanceReady.providerAccountId;

  const payoutLabels = useMemo<PayoutRequirementFieldLabels>(
    () => ({
      destinationCountry: t("DashboardPayments.ramps.destinationCountry"),
      paymentRail: t("DashboardPayments.ramps.paymentRail"),
    }),
    [t]
  );
  // Furthest collect stage wins for stage/field selection; the payout tree
  // prefers the GET answer, which a post-advance refetch keeps fresh.
  const collectAnswer =
    collectRecord !== null && collectRecord.subject === subjectKey
      ? collectRecord.result
      : undefined;
  const requirementsData = collectAnswer !== undefined ? collectAnswer : data;
  const freshTree = payoutTreeOf(data);
  const payout = freshTree !== null ? freshTree : payoutTreeOf(requirementsData);
  const fields = useMemo<RequirementField[]>(() => {
    if (payout !== null) {
      return derivePayoutRequirementFields(payout, collectedData, payoutLabels);
    }
    if (
      requirementsData !== undefined &&
      (requirementsData.status === "collect" || requirementsData.status === "collect_counterparty")
    ) {
      return requirementsData.fields;
    }
    return [];
  }, [collectedData, requirementsData, payout, payoutLabels]);

  const payoutAccounts = useMemo<PayoutRequirementAccount[]>(
    () => (payout === null ? [] : activePayoutAccounts(payout)),
    [payout]
  );
  // An account a refetch no longer lists drops out of the selection with it.
  const selectedEntry = payoutAccounts.find((account) => account.id === selectedPayoutAccountId);
  const selectedPayoutAccount = selectedEntry === undefined ? null : selectedEntry;

  const fieldsComplete = useMemo(
    () =>
      fields
        .flatMap((field) => (field.kind === "address" ? field.fields : [field]))
        .every((field) => requirementFieldError(field, collectedData[field.key]) === null),
    [fields, collectedData]
  );
  const isComplete =
    requirementsData !== undefined && (selectedPayoutAccount !== null || fieldsComplete);

  // Every status the provider can return is handled: "collect" → needsCollection,
  // "ready" → proceed, "unsupported" → block with its reason, plus fetch errors.
  // A fetch error only blocks while no usable answer exists — a failed
  // post-advance refresh must not strand a wizard whose advance succeeded.
  let blockReason: string | null = null;
  if (error instanceof Error && requirementsData === undefined) {
    blockReason = error.message;
  } else if (data?.status === "unsupported") {
    blockReason = data.reason;
  }

  return {
    fields,
    selectedProviderAccountId: selectedPayoutAccount === null ? null : selectedPayoutAccount.id,
    selectedPayoutAccount,
    payoutAccounts,
    selectPayoutAccount,
    collectedData,
    setField,
    needsCollection: requirementsData !== undefined && isCollectStage(requirementsData.status),
    isComplete,
    isResolved: requirementsData !== undefined,
    blockReason,
    onboarding,
    resolvedProviderAccountId,
    submitRequirements,
    isAdvancing,
    retryOnboarding,
  };
}
