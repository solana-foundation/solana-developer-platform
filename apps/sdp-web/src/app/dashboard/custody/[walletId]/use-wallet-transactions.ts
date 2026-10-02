"use client";

import type {
  UnifiedTransactionModule,
  UnifiedTransactionStatus,
  UnifiedTransactionsListResponse,
} from "@sdp/types";
import useSWR, { type SWRConfiguration } from "swr";
import { custodyQueryKeys } from "@/app/dashboard/custody/custody-query-key";
import { dashboardFetch } from "@/lib/dashboard-fetch";

/** Shortest search `/v1/transactions` accepts; the tab sends nothing shorter. */
export const WALLET_TRANSACTIONS_SEARCH_MIN_LENGTH = 3;

/** One page of a wallet's feed, as `/v1/transactions` takes it. */
export interface WalletTransactionsQuery {
  custodyWalletId: string;
  limit: number;
  /** `nextCursor` of the page before; omitted for the newest page. */
  cursor?: string;
  status?: UnifiedTransactionStatus;
  module?: UnifiedTransactionModule;
  /** A kind within `module`; the API refuses a kind without its module. */
  kind?: string;
  /** A prefix of an id, signature or counterparty address, at least three characters. */
  search?: string;
}

/** A failed read, with the proxy's status so the tab can tell "no access" from "down". */
export class WalletTransactionsError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = "WalletTransactionsError";
    this.status = status;
  }
}

/**
 * The `/v1/transactions` query string for one page of a wallet's feed, and the SWR key for the
 * read: the same page asked the same way shares one cache entry.
 */
export function walletTransactionsApiQuery(query: WalletTransactionsQuery): string {
  const params = new URLSearchParams({
    custodyWalletId: query.custodyWalletId,
    limit: String(query.limit),
  });
  for (const key of ["cursor", "status", "module", "kind", "search"] as const) {
    const value = query[key];
    if (value !== undefined) params.set(key, value);
  }
  return params.toString();
}

async function fetchWalletTransactions(apiQuery: string): Promise<UnifiedTransactionsListResponse> {
  const result = await dashboardFetch<{ data: UnifiedTransactionsListResponse }>(
    `/api/dashboard/payments/transactions?${apiQuery}`
  );
  if (!result.ok) throw new WalletTransactionsError(result.error, result.status);
  return result.data.data;
}

/**
 * One page of a wallet's transactions across every module (payments, issuance, earn and the
 * rest), newest first, read again every 20s while the page is open. The API applies the
 * filters and the search to the wallet's whole history and pages it with `nextCursor`; the
 * Overview's recent rows and the Activity tab's pages each have a key of their own.
 */
export function useWalletTransactions(
  query: WalletTransactionsQuery,
  options: Pick<SWRConfiguration<UnifiedTransactionsListResponse>, "keepPreviousData"> = {}
) {
  const apiQuery = walletTransactionsApiQuery(query);
  return useSWR(
    custodyQueryKeys.walletTransactions({ apiQuery }),
    () => fetchWalletTransactions(apiQuery),
    { refreshInterval: 20_000, refreshWhenHidden: false, ...options }
  );
}
