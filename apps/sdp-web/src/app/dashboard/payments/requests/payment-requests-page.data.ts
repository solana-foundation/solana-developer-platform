import {
  type ListPaymentRequestsResponse,
  type PaginatedResponse,
  type PaymentRequest,
  type SolanaCluster,
  WELL_KNOWN_TOKENS,
  type WellKnownToken,
} from "@sdp/types";
import type { SdpApiClient } from "@/lib/sdp-api";

export const PAYMENT_REQUESTS_PAGE_SIZE = 100;

export interface PaymentRequestTokenOption {
  mintAddress: string;
  symbol: string;
}

export type PaymentRequestsLocalErrorCode = "paymentRequestsLoadFailed";
export type PaymentRequestsResult = PaginatedResponse<PaymentRequest> & {
  localErrorCode?: PaymentRequestsLocalErrorCode;
};

/**
 * Well-known tokens deployed on the given cluster. Payment requests are
 * receives, so options are not gated by wallet balances — any requestable
 * token qualifies.
 *
 * @param cluster - Solana cluster the dashboard is currently pointed at.
 * @returns One `{ mintAddress, symbol }` option per well-known token that has
 *   a mint on the cluster (e.g. USDT is skipped on devnet). Never throws.
 */
export function deriveTokenOptions(cluster: SolanaCluster): PaymentRequestTokenOption[] {
  return Object.values(WELL_KNOWN_TOKENS).flatMap((token: WellKnownToken) => {
    const mint = token.mints[cluster];
    return mint ? [{ mintAddress: mint.address, symbol: token.symbol }] : [];
  });
}

/**
 * Fetches one page of payment requests for the authenticated project, newest first, up to
 * {@link PAYMENT_REQUESTS_PAGE_SIZE} rows.
 *
 * @param request - Authenticated SDP API fetcher.
 * @param options - The page (1-based), its size and an optional status.
 * @returns `{ ok: true, data, total }` on success; on any failure (non-2xx or
 *   network error) `{ ok: false, data: [], total: 0, error }` — never throws.
 */
export async function fetchPaymentRequests(
  request: SdpApiClient["request"],
  options: { page?: number; pageSize?: number; status?: PaymentRequest["status"] } = {}
): Promise<PaymentRequestsResult> {
  try {
    const query = new URLSearchParams({
      page: String(options.page ?? 1),
      pageSize: String(options.pageSize ?? PAYMENT_REQUESTS_PAGE_SIZE),
      ...(options.status ? { status: options.status } : {}),
    });
    const response = await request(`/v1/payments/requests?${query.toString()}`);
    if (!response.ok) {
      return { ok: false, data: [], total: 0, error: await response.text() };
    }
    const json = (await response.json()) as { data: ListPaymentRequestsResponse };
    return { ok: true, data: json.data.paymentRequests, total: json.data.total };
  } catch (error) {
    return {
      ok: false,
      data: [],
      total: 0,
      error: error instanceof Error ? error.message : undefined,
      localErrorCode: error instanceof Error ? undefined : "paymentRequestsLoadFailed",
    };
  }
}

/** The most requests the Requests list loads for local search, filtering and paging. */
export const PAYMENT_REQUESTS_CAP = 500;

/**
 * The newest payment requests up to `cap`, read in pages of {@link PAYMENT_REQUESTS_PAGE_SIZE}.
 * The list API has no search, so the Requests list loads this once and searches it locally;
 * `total` is the project's full count, so the list can say when the cap cut it short.
 *
 * @param request - Authenticated SDP API fetcher.
 * @param cap - Most rows to read.
 * @returns The loaded requests and the full total; never throws.
 */
export async function fetchPaymentRequestDirectory(
  request: SdpApiClient["request"],
  cap = PAYMENT_REQUESTS_CAP
): Promise<PaymentRequestsResult> {
  const first = await fetchPaymentRequests(request, { page: 1 });
  if (!first.ok) return first;
  const target = Math.min(first.total, cap);
  const pages = Math.ceil(target / PAYMENT_REQUESTS_PAGE_SIZE);
  const rest = await Promise.all(
    Array.from({ length: Math.max(0, pages - 1) }, (_, index) =>
      fetchPaymentRequests(request, { page: index + 2 })
    )
  );
  const failed = rest.find((result) => !result.ok);
  if (failed) return failed;
  return {
    ok: true,
    data: [first, ...rest].flatMap((result) => result.data).slice(0, cap),
    total: first.total,
  };
}
