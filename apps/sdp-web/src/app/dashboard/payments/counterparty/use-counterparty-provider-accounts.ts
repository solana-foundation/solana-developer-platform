"use client";

import type {
  CounterpartyProviderAccount,
  ListCounterpartyProviderAccountsResponse,
} from "@sdp/types";
import useSWR from "swr";
import { paymentsQueryKeys } from "@/app/dashboard/payments/payments-query-key";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { dashboardFetch } from "@/lib/dashboard-fetch";

type Translate = (key: MessageKey, values?: TranslationValues) => string;

/**
 * Loads provider-owned fiat accounts for a counterparty through the dashboard proxy.
 *
 * @param counterpartyId - Counterparty whose provider accounts should be loaded.
 * @param t - Dashboard translation function for the missing-payload error.
 * @returns Provider account rows for the counterparty.
 */
async function fetchCounterpartyProviderAccounts(
  counterpartyId: string,
  t: Translate
): Promise<CounterpartyProviderAccount[]> {
  const result = await dashboardFetch<{ data: ListCounterpartyProviderAccountsResponse }>(
    `/api/dashboard/counterparty/${encodeURIComponent(counterpartyId)}/provider-accounts`
  );
  if (!result.ok) {
    throw new Error(result.error);
  }
  const accounts = result.data?.data?.accounts;
  if (!accounts) {
    throw new Error(t("DashboardPayments.counterparty.providerAccountsMissing"));
  }
  return accounts;
}

/**
 * Reads provider-owned fiat accounts for a counterparty with the payments query key.
 *
 * @param counterpartyId - Counterparty whose provider accounts should be loaded.
 * @param options.enabled - False when ramps are off; provider accounts are ramp onboarding state.
 * @returns SWR state for the provider account rows.
 */
export function useCounterpartyProviderAccounts(
  counterpartyId: string,
  { enabled }: { enabled: boolean }
) {
  const t = useTranslations();

  return useSWR(
    enabled ? paymentsQueryKeys.counterpartyProviderAccounts({ counterpartyId }) : null,
    () => fetchCounterpartyProviderAccounts(counterpartyId, t),
    { revalidateOnFocus: false }
  );
}
