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

export type PayoutAccountSelection =
  | { kind: "none" }
  | { kind: "existing"; id: string }
  | { kind: "new" };

/**
 * Resolves the default payout account choice for a country with one active account.
 *
 * @param selection - Current payout account choice.
 * @param accounts - Active payout accounts for the selected country.
 * @returns The supplied choice, or the single active account choice.
 */
export function resolvePayoutAccountSelection(
  selection: PayoutAccountSelection,
  accounts: PayoutRequirementAccount[]
): PayoutAccountSelection {
  if (selection.kind === "none" && accounts.length === 1) {
    const account = accounts[0];
    if (account === undefined) {
      throw new Error("A single payout account was expected to be available.");
    }
    return { kind: "existing", id: account.id };
  }
  return selection;
}

/**
 * Resets a payout account choice when the destination country changes.
 *
 * @param selection - Current payout account choice.
 * @param fieldKey - Field being changed.
 * @param previousCountry - Previously collected destination country.
 * @param nextCountry - New destination country value.
 * @returns The reset choice when the country changed, otherwise the current choice.
 */
export function payoutAccountSelectionAfterFieldChange(
  selection: PayoutAccountSelection,
  fieldKey: string,
  previousCountry: string | undefined,
  nextCountry: string
): PayoutAccountSelection {
  if (fieldKey === "destinationCountry" && previousCountry !== nextCountry) {
    return { kind: "none" };
  }
  return selection;
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
  labels: PayoutRequirementFieldLabels,
  payoutAccountSelection: PayoutAccountSelection
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
  if (
    activePayoutAccounts(payout, destinationCountry).length > 0 &&
    payoutAccountSelection.kind !== "new"
  ) {
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
}

export interface CounterpartyRequirementsState {
  /** Fields the client must collect; empty unless the provider returned `collect`. */
  fields: RequirementField[];
  /** Active corridor accounts available for reuse in the selected payout country. */
  existingPayoutAccounts: PayoutRequirementAccount[];
  payoutAccountSelection: PayoutAccountSelection;
  selectedProviderAccountId: string | null;
  addingNewAccount: boolean;
  selectPayoutAccount: (selection: PayoutAccountSelection) => void;
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
  const [payoutAccountSelection, setPayoutAccountSelection] = useState<PayoutAccountSelection>({
    kind: "none",
  });
  const setField = (key: string, value: string) => {
    const nextPayoutAccountSelection = payoutAccountSelectionAfterFieldChange(
      payoutAccountSelection,
      key,
      collectedData.destinationCountry,
      value
    );
    if (nextPayoutAccountSelection !== payoutAccountSelection) {
      setPayoutAccountSelection(nextPayoutAccountSelection);
    }
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
  const selectPayoutAccount = (selection: PayoutAccountSelection) => {
    setPayoutAccountSelection(selection);
    setCollectedData((previous) => {
      const next: CollectedFieldData = {};
      if (previous.destinationCountry !== undefined) {
        next.destinationCountry = previous.destinationCountry;
      }
      return next;
    });
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
  const [isAdvancing, setIsAdvancing] = useState(false);
  // The request subject plus the collected destination country (which lives
  // outside the subject key): together the full corridor an advance or poll
  // response answers for.
  const corridorIdentity = `${subjectKey}:${
    collectedData.destinationCountry === undefined ? "" : collectedData.destinationCountry
  }`;
  if (subjectKey !== trackedSubject) {
    setTrackedSubject(subjectKey);
    setCollectedData({});
    setPayoutAccountSelection({ kind: "none" });
    setAdvanceRecord(null);
  }
  const advance =
    advanceRecord !== null && advanceRecord.corridor === corridorIdentity ? advanceRecord : null;

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
  const { data, error } = useSWR(
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
    const corridor = corridorIdentity;
    setIsAdvancing(true);
    try {
      const result = await advanceCounterpartyRequirements(
        params.counterpartyId,
        params.provider,
        params.direction,
        {
          ...payload,
          collectedData,
          ...(selectedProviderAccountId === null
            ? {}
            : { providerAccountId: selectedProviderAccountId }),
        },
        t
      );
      setAdvanceRecord({ corridor, advanceId: crypto.randomUUID(), payload, result });
      return result;
    } finally {
      setIsAdvancing(false);
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
  const resolvedProviderAccountId =
    onboarding !== null &&
    onboarding.status === "ready" &&
    onboarding.providerAccountId !== undefined
      ? onboarding.providerAccountId
      : null;

  const payoutLabels = useMemo<PayoutRequirementFieldLabels>(
    () => ({
      destinationCountry: t("DashboardPayments.ramps.destinationCountry"),
      paymentRail: t("DashboardPayments.ramps.paymentRail"),
    }),
    [t]
  );
  // Progressive collection: an advance answered with a fresh field set (or a
  // refreshed payout tree) supersedes the immutable initial GET for the current
  // corridor — derived here rather than written into the SWR cache.
  const requirementsData =
    advance !== null &&
    (advance.result.status === "collect" ||
      advance.result.status === "collect_counterparty" ||
      advance.result.status === "collect_account")
      ? advance.result
      : data;
  const payout =
    requirementsData !== undefined && requirementsData.status === "collect_account"
      ? requirementsData.payout
      : null;
  const existingPayoutAccounts = useMemo(
    () =>
      payout === null || collectedData.destinationCountry === undefined
        ? []
        : activePayoutAccounts(payout, collectedData.destinationCountry),
    [collectedData.destinationCountry, payout]
  );
  // A ready advance resolves the corridor's payout account; it seeds an empty
  // choice so the chooser and the quote agree, but never overrides an explicit
  // user selection made afterwards.
  const effectivePayoutAccountSelection = resolvePayoutAccountSelection(
    payoutAccountSelection.kind === "none" && resolvedProviderAccountId !== null
      ? { kind: "existing", id: resolvedProviderAccountId }
      : payoutAccountSelection,
    existingPayoutAccounts
  );
  const fields = useMemo<RequirementField[]>(() => {
    if (payout !== null) {
      return derivePayoutRequirementFields(
        payout,
        collectedData,
        payoutLabels,
        effectivePayoutAccountSelection
      );
    }
    if (
      requirementsData !== undefined &&
      (requirementsData.status === "collect" || requirementsData.status === "collect_counterparty")
    ) {
      return requirementsData.fields;
    }
    return [];
  }, [collectedData, requirementsData, effectivePayoutAccountSelection, payout, payoutLabels]);

  const selectedProviderAccountId =
    effectivePayoutAccountSelection.kind === "existing" ? effectivePayoutAccountSelection.id : null;
  const addingNewAccount = effectivePayoutAccountSelection.kind === "new";

  const isComplete = useMemo(
    () =>
      fields
        .flatMap((field) => (field.kind === "address" ? field.fields : [field]))
        .every((field) => requirementFieldError(field, collectedData[field.key]) === null),
    [fields, collectedData]
  );
  const isPayoutAccountChoiceComplete =
    existingPayoutAccounts.length === 0 || effectivePayoutAccountSelection.kind !== "none";

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
    payoutAccountSelection: effectivePayoutAccountSelection,
    selectedProviderAccountId,
    addingNewAccount,
    selectPayoutAccount,
    collectedData,
    setField,
    needsCollection:
      requirementsData?.status === "collect" ||
      requirementsData?.status === "collect_counterparty" ||
      requirementsData?.status === "collect_account",
    isComplete: isComplete && isPayoutAccountChoiceComplete,
    isResolved: requirementsData !== undefined,
    blockReason,
    onboarding,
    resolvedProviderAccountId,
    submitRequirements,
    isAdvancing,
    retryOnboarding,
  };
}
