import type { UnifiedTransactionsListResponse } from "@sdp/types";
import { dashboardFetch } from "@/lib/dashboard-fetch";
import type { SdpApiClient } from "@/lib/sdp-api";
import type { TransactionFilters } from "./transactions-query";
import { toTransactionsApiQuery } from "./transactions-query";

export type TransactionsPageResult = UnifiedTransactionsListResponse;

const TRANSACTIONS_PAGE_SIZE = 25;

/**
 * The `/v1/transactions` query string for one dashboard page (25 rows), and
 * the SWR key for the client fetch: identical filter sets share one cache
 * entry.
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
 * Fetches `/v1/transactions` through the `/api/dashboard/payments/transactions`
 * proxy, which authenticates the session server-side and forwards the query
 * string untouched. Throws on a non-ok response so SWR surfaces it as `error`.
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
