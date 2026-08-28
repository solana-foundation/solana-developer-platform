"use client";

import type { CounterpartyFieldOptions } from "@sdp/types";
import useSWR from "swr";
import { paymentsQueryKeys } from "@/app/dashboard/payments/payments-query-key";
import { useTranslations } from "@/i18n/provider";
import { fetchCounterpartyMetadata } from "./counterparty-metadata.data";

export function useCounterpartyMetadata() {
  const t = useTranslations();
  const { data, error } = useSWR<CounterpartyFieldOptions>(
    paymentsQueryKeys.counterpartyFieldOptions(),
    () => fetchCounterpartyMetadata(t),
    { revalidateOnFocus: false, revalidateIfStale: false }
  );

  return {
    metadata: data ?? null,
    loading: data === undefined && !error,
    error:
      error instanceof Error ? error.message : error ? t("DashboardPayments.requestFailed") : null,
  };
}
