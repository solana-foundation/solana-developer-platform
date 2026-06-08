"use client";

import type { CounterpartyFieldOptions } from "@sdp/types";
import useSWR from "swr";
import { COUNTERPARTY_METADATA_KEY, fetchCounterpartyMetadata } from "./counterparty-metadata.data";

export function useCounterpartyMetadata() {
  const { data, error } = useSWR<CounterpartyFieldOptions>(
    COUNTERPARTY_METADATA_KEY,
    fetchCounterpartyMetadata,
    { revalidateOnFocus: false, revalidateIfStale: false }
  );

  return {
    metadata: data ?? null,
    loading: data === undefined && !error,
    error: error instanceof Error ? error.message : error ? "Request failed." : null,
  };
}
