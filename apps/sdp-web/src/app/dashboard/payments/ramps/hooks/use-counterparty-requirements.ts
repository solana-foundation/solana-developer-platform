"use client";

import type { RampProviderId } from "@sdp/types";
import type { RampFiatCurrency } from "@sdp/types/generated/ramp-support";
import type {
  CollectedFieldData,
  CounterpartyRequirements,
  RampDirection,
  RequirementField,
} from "@sdp/types/ramp-requirements";
import { useMemo, useState } from "react";
import useSWR from "swr";
import { getApiError } from "@/app/dashboard/payments/payments-workspace.data";

async function fetchCounterpartyRequirements(
  counterpartyId: string,
  provider: RampProviderId,
  direction: RampDirection,
  fiatCurrency: RampFiatCurrency | undefined
): Promise<CounterpartyRequirements> {
  const params = new URLSearchParams({ provider, direction });
  if (fiatCurrency !== undefined) {
    params.set("fiatCurrency", fiatCurrency);
  }
  const response = await fetch(
    `/api/dashboard/counterparty/${encodeURIComponent(counterpartyId)}/requirements?${params.toString()}`
  );
  const body = (await response.json().catch(() => ({}))) as {
    data?: CounterpartyRequirements;
    error?: { message?: string };
  };

  if (!response.ok || !body.data) {
    throw new Error(getApiError(body, `Requirements request failed (${response.status}).`));
  }

  return body.data;
}

export interface CounterpartyRequirementsParams {
  counterpartyId: string;
  provider: RampProviderId | null;
  direction: RampDirection;
  /** Payout currency — required by lightspark offramp requirements; ignored by other providers. */
  fiatCurrency?: RampFiatCurrency;
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
  const [collectedData, setCollectedData] = useState<CollectedFieldData>({});
  const setField = (key: string, value: string) => {
    setCollectedData((prev) => ({ ...prev, [key]: value }));
  };

  // Reset collected answers when the counterparty/provider/currency changes by comparing
  // the previous value during render (React's no-effect way to reset state on a change),
  // so stale KYC or bank details never leak into a different provider's payload.
  const subjectKey =
    params === null ? "" : `${params.counterpartyId}:${params.provider}:${params.fiatCurrency}`;
  const [trackedSubject, setTrackedSubject] = useState(subjectKey);
  if (subjectKey !== trackedSubject) {
    setTrackedSubject(subjectKey);
    setCollectedData({});
  }

  const key =
    params?.provider && params.counterpartyId
      ? ([
          "counterparty-requirements",
          params.counterpartyId,
          params.provider,
          params.direction,
          params.fiatCurrency,
        ] as const)
      : null;
  // Requirements are deterministic for a (counterparty, provider, currency) for the
  // wizard's lifetime — never revalidate, so `needsCollection` (and thus the wizard's
  // step list) can't flip out from under the user mid-flow.
  const { data, error } = useSWR(
    key,
    ([, counterpartyId, provider, direction, fiatCurrency]) =>
      fetchCounterpartyRequirements(counterpartyId, provider, direction, fiatCurrency),
    { revalidateOnFocus: false, revalidateOnReconnect: false, revalidateIfStale: false }
  );

  const fields = useMemo<RequirementField[]>(
    () => (data?.status === "collect" ? data.fields : []),
    [data]
  );

  const isComplete = useMemo(
    () =>
      fields.every((field) => {
        if (!field.required) {
          return true;
        }
        const value = collectedData[field.key];
        return value !== undefined && value.trim().length > 0;
      }),
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
    collectedData,
    setField,
    needsCollection: data?.status === "collect",
    isComplete,
    isResolved: data !== undefined,
    blockReason,
  };
}
