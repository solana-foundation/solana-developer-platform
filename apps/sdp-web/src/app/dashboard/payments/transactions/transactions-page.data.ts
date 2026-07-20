import type { PaymentTransferSummary } from "@sdp/types";
import type { SdpApiClient } from "@/lib/sdp-api";
import type { TransactionFilters } from "./transactions-query";
import { toTransactionsApiQuery } from "./transactions-query";

export interface TransactionsPageResult {
  transfers: PaymentTransferSummary[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  error: string | null;
}

export async function fetchTransactionsPage(
  request: SdpApiClient["request"],
  filters: TransactionFilters
): Promise<TransactionsPageResult> {
  try {
    const response = await request(`/v1/payments/transfers?${toTransactionsApiQuery(filters)}`);
    const body = (await response.json().catch(() => ({}))) as {
      data?: PaymentTransferSummary[];
      meta?: { total?: number; page?: number; pageSize?: number; hasMore?: boolean };
      error?: { message?: string };
    };

    if (!response.ok) {
      return {
        transfers: [],
        total: 0,
        page: filters.page,
        pageSize: filters.pageSize,
        hasMore: false,
        error: body.error?.message ?? `Transaction list request failed (${response.status}).`,
      };
    }

    return {
      transfers: body.data ?? [],
      total: body.meta?.total ?? 0,
      page: body.meta?.page ?? filters.page,
      pageSize: body.meta?.pageSize ?? filters.pageSize,
      hasMore: body.meta?.hasMore ?? false,
      error: null,
    };
  } catch (error) {
    return {
      transfers: [],
      total: 0,
      page: filters.page,
      pageSize: filters.pageSize,
      hasMore: false,
      error: error instanceof Error ? error.message : "Transaction list request failed.",
    };
  }
}
