import type { UnifiedTransactionsListResponse } from "@sdp/types";
import { dashboardFetch } from "@/lib/dashboard-fetch";
import type { SdpApiClient } from "@/lib/sdp-api";
import type { TransactionFilters } from "./transactions-query";
import { toTransactionsApiQuery } from "./transactions-query";

export type TransactionsPageResult = UnifiedTransactionsListResponse;

const TRANSACTIONS_PAGE_SIZE = 25;

/**
 * The `/v1/transactions` query string for a filter set; the SWR key for the
 * client fetch, so identical filter sets share one cache entry.
 *
 * @param filters - The active filter set.
 * @returns The serialized API query.
 */
export function transactionsApiQuery(filters: TransactionFilters): string {
  return toTransactionsApiQuery(filters, TRANSACTIONS_PAGE_SIZE).toString();
}

export async function fetchTransactionsPage(
  apiClient: SdpApiClient,
  filters: TransactionFilters
): Promise<TransactionsPageResult> {
  return apiClient.fetch<UnifiedTransactionsListResponse>(
    `/v1/transactions?${transactionsApiQuery(filters)}`
  );
}

/**
 * Browser-side page fetch through the dashboard proxy route. Throws on a failed
 * response so SWR surfaces it as `error`.
 *
 * @param apiQuery - The serialized API query from `transactionsApiQuery`.
 * @returns The transactions page.
 */
export async function fetchTransactionsPageFromDashboard(
  apiQuery: string
): Promise<TransactionsPageResult> {
  const result = await dashboardFetch<{ data: UnifiedTransactionsListResponse }>(
    `/api/dashboard/payments/transactions?${apiQuery}`
  );
  if (!result.ok) throw new Error(result.error);
  return result.data.data;
}
