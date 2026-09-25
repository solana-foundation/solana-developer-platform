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

export type PaymentRequestDetailResult =
  | { status: "found"; request: PaymentRequest }
  | { status: "not_found" }
  | { status: "error"; error: string | undefined };

/**
 * One payment request by id. The API reads requests only as a list, so this pages through it
 * newest first, as far as the Requests list itself reads ({@link PAYMENT_REQUESTS_CAP}), and
 * stops at the match; a request just created is on the first page.
 *
 * @param request - Authenticated SDP API fetcher.
 * @param requestId - The request's id.
 * @returns The request, `not_found`, or the load error; never throws.
 */
export async function fetchPaymentRequestDetail(
  request: SdpApiClient["request"],
  requestId: string
): Promise<PaymentRequestDetailResult> {
  const pages = Math.ceil(PAYMENT_REQUESTS_CAP / PAYMENT_REQUESTS_PAGE_SIZE);
  for (let page = 1; page <= pages; page += 1) {
    const result = await fetchPaymentRequests(request, { page });
    if (!result.ok) return { status: "error", error: result.error };
    const match = result.data.find((candidate) => candidate.id === requestId);
    if (match) return { status: "found", request: match };
    if (page * PAYMENT_REQUESTS_PAGE_SIZE >= result.total) break;
  }
  return { status: "not_found" };
}
