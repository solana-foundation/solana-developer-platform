"use client";

import useSWR from "swr";
import { paymentsQueryKeys } from "@/app/dashboard/payments/payments-query-key";
import { fetchCounterpartyProviderAccounts } from "@/app/dashboard/payments/payments-workspace.data";
import { useTranslations } from "@/i18n/provider";

/**
 * Reads provider-owned fiat accounts for a counterparty with the payments query key.
 *
 * @param counterpartyId - Counterparty whose provider accounts should be loaded.
 * @returns SWR state for the provider account rows.
 */
export function useCounterpartyProviderAccounts(counterpartyId: string) {
  const t = useTranslations();

  return useSWR(
    paymentsQueryKeys.counterpartyProviderAccounts({ counterpartyId }),
    () => fetchCounterpartyProviderAccounts(counterpartyId, t),
    { revalidateOnFocus: false, revalidateIfStale: false, keepPreviousData: false }
  );
}
