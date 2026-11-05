"use client";

import { paymentsQueryKeys } from "@/app/(session)/dashboard/[projectId]/payments/payments-query-key";
import { useDashboardKeyScope, useDashboardRead } from "@/lib/dashboard-swr";
import { counterpartyProviderAccountsResponseSchema } from "./counterparty-read-schemas";

/**
 * Reads provider-owned fiat accounts for a counterparty.
 *
 * @param counterpartyId - Counterparty whose provider accounts should be loaded.
 * @param options.enabled - False when ramps are off; provider accounts are ramp onboarding state.
 * @returns SWR state for the provider account rows.
 */
export function useCounterpartyProviderAccounts(
  counterpartyId: string,
  { enabled }: { enabled: boolean }
) {
  const scope = useDashboardKeyScope();
  const response = useDashboardRead(
    enabled ? paymentsQueryKeys.counterpartyProviderAccounts(scope, counterpartyId) : null,
    counterpartyProviderAccountsResponseSchema,
    { revalidateOnFocus: false }
  );
  return { ...response, data: response.data?.data.accounts };
}
