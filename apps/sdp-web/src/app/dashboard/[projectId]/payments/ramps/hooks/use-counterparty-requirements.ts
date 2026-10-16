"use client";

import type { CryptoRailId, RampProviderId } from "@sdp/types";
import type { RampFiatCurrency } from "@sdp/types/generated/ramp";
import type {
  CollectedFieldData,
  CounterpartyRequirements,
  RampDirection,
  RequirementField,
} from "@sdp/types/ramp-requirements";
import {
  isCollectFieldsRequirements,
  isCollectStageStatus,
  isCounterpartyRequirementsPollStatus,
} from "@sdp/types/ramp-requirements";
import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import {
  buildCounterpartyRequirementsKey,
  type CounterpartyRequirementsParams,
  paymentsQueryKeys,
} from "@/app/dashboard/[projectId]/payments/payments-query-key";

export type { CounterpartyRequirementsParams };

import { getApiError } from "@/app/dashboard/[projectId]/payments/payments-workspace.data";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { dashboardRequest } from "@/lib/dashboard-fetch";
import { requirementFieldError } from "../schema";

type Translate = (key: MessageKey, values?: TranslationValues) => string;

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
    assetRail: corridor.assetRail,
    fiatCurrency: corridor.fiatCurrency,
  });
  if (direction === "onramp") {
    params.set("destinationCustodyWalletId", corridor.destinationCustodyWalletId);
  }
  const response = await dashboardRequest(
    `/api/dashboard/counterparty/${encodeURIComponent(counterpartyId)}/requirements?${params.toString()}`,
    {}
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
  assetRail: CryptoRailId;
  destinationCustodyWalletId: string;
  fiatCurrency: RampFiatCurrency;
}

/** Advance kinds select the submission body: collected field data, or a pure consent flag. */
export type AdvanceRequirementsKind = "collected" | "consent";

/**
 * Consent keys one pending agreement requires: the agreement text and its
 * privacy policy are acknowledged separately, so each gets its own key.
 *
 * @param agreement - Pending agreement from the requirements answer.
 * @returns The two consent keys the step gate expects for this agreement.
 */
export function bvnkAgreementConsentKeys(agreement: { name: string }): {
  agreement: string;
  privacyPolicy: string;
} {
  return { agreement: agreement.name, privacyPolicy: `${agreement.name}:privacy-policy` };
}

type CounterpartyRequirementsAdvanceBody =
  | (AdvanceRequirementsPayload & { collectedData: CollectedFieldData })
  | (AdvanceRequirementsPayload & { agreementConsent: true });

/**
 * Shapes the advance POST body: a consent advance carries only the consent
 * flag; a collected advance carries the client-collected fields.
 *
 * @param payload - Corridor identity the advance answers for.
 * @param advance - Whether this advance submits collected data or consent.
 * @param collectedData - Fields collected so far for the current stage.
 * @returns The request body for the requirements advance.
 */
function buildAdvanceBody(
  payload: AdvanceRequirementsPayload,
  advance: AdvanceRequirementsKind,
  collectedData: CollectedFieldData
): CounterpartyRequirementsAdvanceBody {
  return advance === "consent"
    ? { ...payload, agreementConsent: true }
    : { ...payload, collectedData };
}

async function advanceCounterpartyRequirements(
  counterpartyId: string,
  provider: RampProviderId,
  direction: RampDirection,
  advanceBody: CounterpartyRequirementsAdvanceBody,
  t: Translate
): Promise<CounterpartyRequirements> {
  const response = await dashboardRequest(
    `/api/dashboard/counterparty/${encodeURIComponent(counterpartyId)}/requirements`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, direction, ...advanceBody }),
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
  kind: AdvanceRequirementsKind;
  result: CounterpartyRequirements;
}

type PendingAgreements = Extract<
  CounterpartyRequirements,
  { status: "counterparty_collect_agreement" }
>["agreements"];

/**
 * Names the request corridor: every field of the request that, when it
 * changes, resets the collected answers.
 *
 * @param params - The hook's request, or null when it is disabled.
 * @returns The subject key, empty when disabled.
 */
function requirementsSubjectKey(params: CounterpartyRequirementsParams | null): string {
  return params === null
    ? ""
    : `${params.counterpartyId}:${params.provider}:${params.direction}:${params.assetRail}:${params.fiatCurrency}:${params.destinationCustodyWalletId}`;
}

/**
 * Reads a corridor-tagged record only while it answers for the current corridor.
 *
 * @param record - The stored record, tagged with the corridor it answered for.
 * @param corridor - The current corridor identity.
 * @returns The record, or null when it belongs to another corridor.
 */
function recordForCorridor<Entry extends { corridor: string }>(
  record: Entry | null,
  corridor: string
): Entry | null {
  return record !== null && record.corridor === corridor ? record : null;
}

/**
 * Keys the onboarding status poll, or disables it while there is nothing pending to poll.
 *
 * @param advance - The current corridor's advance, if any.
 * @param params - The hook's request.
 * @param subjectKey - The current corridor identity.
 * @returns The poll key, or null.
 */
function onboardingPollKey(
  advance: AdvanceRecord | null,
  params: CounterpartyRequirementsParams | null,
  subjectKey: string
) {
  return advance !== null &&
    params?.provider &&
    isCounterpartyRequirementsPollStatus(advance.result.status)
    ? paymentsQueryKeys.requirementsStatusPoll({
        subjectKey: `${subjectKey}#${advance.advanceId}`,
      })
    : null;
}

/**
 * The freshest onboarding answer for the current corridor: the poll's when it
 * has one, otherwise the advance response.
 */
function currentOnboarding(
  advance: AdvanceRecord | null,
  polled: CounterpartyRequirements | undefined
): CounterpartyRequirements | null {
  return advance === null ? null : polled !== undefined ? polled : advance.result;
}

/**
 * Reads the agreements awaiting consent off a requirements answer.
 *
 * @param answer - Requirements answer to inspect.
 * @returns The agreements, or null when the step collects fields instead.
 */
function pendingAgreementsOf(
  answer: CounterpartyRequirements | undefined
): PendingAgreements | null {
  return answer !== undefined && answer.status === "counterparty_collect_agreement"
    ? answer.agreements
    : null;
}

/**
 * Whether every pending agreement and its privacy policy has been checked.
 *
 * @param pending - Agreements awaiting consent, or null when there are none.
 * @param acceptedAgreements - Consent keys checked so far.
 * @returns False when nothing is pending.
 */
function everyAgreementAccepted(
  pending: PendingAgreements | null,
  acceptedAgreements: readonly string[]
): boolean {
  if (pending === null) {
    return false;
  }
  const accepted = new Set(acceptedAgreements);
  return pending.every((agreement) => {
    const keys = bvnkAgreementConsentKeys(agreement);
    return accepted.has(keys.agreement) && accepted.has(keys.privacyPolicy);
  });
}

/**
 * Every status the provider can return is handled: "collect" → needsCollection,
 * "ready" → proceed, "unsupported" → block with its reason, plus fetch errors.
 * A fetch error only blocks while no usable answer exists: a failed refetch
 * must not strand a wizard whose advance succeeded.
 */
function requirementsBlockReason(
  error: unknown,
  requirementsData: CounterpartyRequirements | undefined,
  data: CounterpartyRequirements | undefined
): string | null {
  if (error instanceof Error && requirementsData === undefined) {
    return error.message;
  }
  if (data?.status === "unsupported") {
    return data.reason;
  }
  return null;
}

export interface CounterpartyRequirementsState {
  /** Fields the client must collect; empty unless the provider returned `collect`. */
  fields: RequirementField[];
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
   * Advances provider provisioning; resolves to the new lifecycle state. The
   * kind selects the submission body: collected field data, or a pure consent
   * flag with no collected data.
   */
  submitRequirements: (
    payload: AdvanceRequirementsPayload,
    advance: AdvanceRequirementsKind
  ) => Promise<CounterpartyRequirements>;
  /** An advance POST is in flight. */
  isAdvancing: boolean;
  /** Re-runs the advance (POST) to retry — used by the customer funding provisioning failure action. */
  retryOnboarding: () => void;
  /** Reads the onboarding status now instead of on the poll's next tick. */
  refreshOnboarding: () => Promise<void>;
  /** Agreements awaiting consent on the requirements step, or null when the step collects fields. */
  pendingAgreements:
    | Extract<CounterpartyRequirements, { status: "counterparty_collect_agreement" }>["agreements"]
    | null;
  /**
   * Consent keys (see `bvnkAgreementConsentKeys`) the user has ticked for the
   * current corridor; cleared whenever the corridor changes so consent never
   * leaks across subjects.
   */
  acceptedAgreements: readonly string[];
  /**
   * Records or withdraws one consent key; the step gate releases only once
   * every pending agreement has both of its keys accepted.
   *
   * @param key - A consent key from `bvnkAgreementConsentKeys`.
   * @param accepted - Whether the user checked (true) or unchecked (false) it.
   */
  toggleAgreement: (key: string, accepted: boolean) => void;
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
  const [acceptedAgreements, setAcceptedAgreements] = useState<readonly string[]>([]);
  const setField = (key: string, value: string) => {
    setCollectedData((previous) => ({ ...previous, [key]: value }));
  };

  // Reset collected answers when any request-corridor field changes by comparing
  // the previous value during render (React's no-effect way to reset state on a change),
  // so stale KYC or bank details never leak into a different corridor's payload and a
  // pending onboarding never survives into one.
  const subjectKey = requirementsSubjectKey(params);
  const [trackedSubject, setTrackedSubject] = useState(subjectKey);
  // The completed advance, tagged with the corridor it answered for. Responses
  // are data addressed by their corridor, never commands: a write from a
  // continuation that raced a corridor change is inert because every read
  // filters on the CURRENT corridor identity — no application-time guards.
  const [advanceRecord, setAdvanceRecord] = useState<AdvanceRecord | null>(null);
  const [collectRecord, setCollectRecord] = useState<{
    corridor: string;
    result: CounterpartyRequirements;
  } | null>(null);
  const [isAdvancing, setIsAdvancing] = useState(false);
  if (subjectKey !== trackedSubject) {
    setTrackedSubject(subjectKey);
    setCollectedData({});
    setAcceptedAgreements([]);
    setAdvanceRecord(null);
    setCollectRecord(null);
  }
  const toggleAgreement = useCallback((key: string, accepted: boolean) => {
    setAcceptedAgreements((previous) =>
      accepted ? [...previous, key] : previous.filter((acceptedKey) => acceptedKey !== key)
    );
  }, []);
  const advance = recordForCorridor(advanceRecord, subjectKey);

  const key = buildCounterpartyRequirementsKey(params);
  // Requirements never revalidate on their own — `needsCollection` (and thus the
  // wizard's step list) can't flip out from under the user mid-flow.
  const { data, error } = useSWR(
    key,
    ([
      ,
      counterpartyId,
      provider,
      direction,
      assetRail,
      fiatCurrency,
      destinationCustodyWalletId,
    ]) =>
      fetchCounterpartyRequirements(
        counterpartyId,
        provider,
        direction,
        { assetRail, fiatCurrency, destinationCustodyWalletId },
        t
      ),
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      revalidateIfStale: false,
    }
  );

  const submitRequirements = async (
    payload: AdvanceRequirementsPayload,
    advance: AdvanceRequirementsKind
  ): Promise<CounterpartyRequirements> => {
    if (!params?.provider || !params.counterpartyId) {
      throw new Error(t("DashboardPayments.workspace.requirementsContextMissing"));
    }
    const corridor = subjectKey;
    setIsAdvancing(true);
    try {
      const advanceBody = buildAdvanceBody(payload, advance, collectedData);
      const result = await advanceCounterpartyRequirements(
        params.counterpartyId,
        params.provider,
        params.direction,
        advanceBody,
        t
      );
      setAdvanceRecord({
        corridor,
        advanceId: crypto.randomUUID(),
        payload,
        kind: advance,
        result,
      });
      if (isCollectStageStatus(result.status)) {
        setCollectRecord({ corridor, result });
      }
      return result;
    } finally {
      setIsAdvancing(false);
    }
  };

  const retryOnboarding = () => {
    if (advance !== null) {
      void submitRequirements(advance.payload, advance.kind).catch(() => {});
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
  const pollKey = onboardingPollKey(advance, params, subjectKey);
  const { data: polledOnboarding, mutate: refreshPolledOnboarding } = useSWR(
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
        latest !== undefined && !isCounterpartyRequirementsPollStatus(latest.status) ? 0 : 4000,
      revalidateOnFocus: false,
      dedupingInterval: 0,
      onSuccess: (latest) => {
        if (isCollectStageStatus(latest.status)) {
          setCollectRecord({ corridor: subjectKey, result: latest });
        }
      },
    }
  );

  // The live onboarding lifecycle for the CURRENT corridor: the freshest of the
  // advance response and its status poll. Both sources are corridor-addressed,
  // so an abandoned corridor's result can never surface here.
  const onboarding = currentOnboarding(advance, polledOnboarding);

  // The furthest collect stage wins for stage and field selection.
  const collectAnswer = recordForCorridor(collectRecord, subjectKey);
  const requirementsData = collectAnswer !== null ? collectAnswer.result : data;
  const pendingAgreements = pendingAgreementsOf(requirementsData);
  const fields = useMemo<RequirementField[]>(
    () =>
      requirementsData !== undefined && isCollectFieldsRequirements(requirementsData)
        ? requirementsData.fields
        : [],
    [requirementsData]
  );

  const fieldsComplete = useMemo(
    () =>
      fields
        .flatMap((field) => (field.kind === "address" ? field.fields : [field]))
        .every((field) => requirementFieldError(field, collectedData[field.key]) === null),
    [fields, collectedData]
  );
  const isComplete =
    requirementsData !== undefined &&
    (pendingAgreements !== null
      ? everyAgreementAccepted(pendingAgreements, acceptedAgreements)
      : fieldsComplete);

  const blockReason = requirementsBlockReason(error, requirementsData, data);

  return {
    fields,
    collectedData,
    setField,
    needsCollection:
      requirementsData !== undefined && isCollectStageStatus(requirementsData.status),
    isComplete,
    isResolved: requirementsData !== undefined,
    blockReason,
    onboarding,
    submitRequirements,
    isAdvancing,
    retryOnboarding,
    refreshOnboarding: async () => {
      await refreshPolledOnboarding();
    },
    pendingAgreements,
    acceptedAgreements,
    toggleAgreement,
  };
}
