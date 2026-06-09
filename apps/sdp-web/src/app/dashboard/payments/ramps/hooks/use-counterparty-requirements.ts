"use client";

import type { RampProviderId } from "@sdp/types";
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
  direction: RampDirection
): Promise<CounterpartyRequirements> {
  const params = new URLSearchParams({ provider, direction });
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
  /** A requirements lookup is in flight (provider chosen, answer not yet known). */
  isLoading: boolean;
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

  const key =
    params?.provider && params.counterpartyId
      ? ([
          "counterparty-requirements",
          params.counterpartyId,
          params.provider,
          params.direction,
        ] as const)
      : null;
  const { data, isLoading } = useSWR(
    key,
    ([, counterpartyId, provider, direction]) =>
      fetchCounterpartyRequirements(counterpartyId, provider, direction),
    { revalidateOnFocus: false }
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

  return {
    fields,
    collectedData,
    setField,
    needsCollection: data?.status === "collect",
    isComplete,
    isLoading,
  };
}
