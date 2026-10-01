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

/** Rows a page of the Requests list shows until the user picks another size. */
export const PAYMENT_REQUESTS_LIST_DEFAULT_PAGE_SIZE = 25;

const PAYMENT_REQUEST_STATUSES = [
  "awaiting_payment",
  "paid",
  "canceled",
  "expired",
] as const satisfies readonly PaymentRequest["status"][];

/** The Requests list's page, its size and its status filter, as the URL carries them. */
export interface PaymentRequestsListState {
  page: number;
  pageSize: number;
  status: PaymentRequest["status"] | null;
}

function firstParamValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseListInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || !/^\d+$/.test(value)) {
    return fallback;
  }
  const parsed = Number(value);
  return parsed > 0 ? parsed : fallback;
}

/**
 * The Requests list's state from its URL. Anything missing or malformed falls back to the
 * first page, the default size and every status; the size never exceeds what the API serves.
 *
 * @param params - The route's search params.
 * @returns The page, its size and the status filter.
 */
export function parsePaymentRequestsListParams(
  params: Record<string, string | string[] | undefined>
): PaymentRequestsListState {
  const status = firstParamValue(params.status);
  return {
    page: parseListInteger(firstParamValue(params.page), 1),
    pageSize: Math.min(
      parseListInteger(firstParamValue(params.pageSize), PAYMENT_REQUESTS_LIST_DEFAULT_PAGE_SIZE),
      PAYMENT_REQUESTS_PAGE_SIZE
    ),
    status: PAYMENT_REQUEST_STATUSES.find((candidate) => candidate === status) ?? null,
  };
}

export type PaymentRequestDetailResult =
  | { status: "found"; request: PaymentRequest }
  | { status: "not_found" }
  | { status: "error"; error: string | undefined };

/**
 * One payment request by id. The API reads requests only as a list, so this pages through it
 * newest first and stops at the match, or once the pages run out; a request just created is on
 * the first page.
 *
 * @param request - Authenticated SDP API fetcher.
 * @param requestId - The request's id.
 * @returns The request, `not_found`, or the load error; never throws.
 */
export async function fetchPaymentRequestDetail(
  request: SdpApiClient["request"],
  requestId: string
): Promise<PaymentRequestDetailResult> {
  for (let page = 1; ; page += 1) {
    const result = await fetchPaymentRequests(request, { page });
    if (!result.ok) return { status: "error", error: result.error };
    const match = result.data.find((candidate) => candidate.id === requestId);
    if (match) return { status: "found", request: match };
    if (result.data.length === 0 || page * PAYMENT_REQUESTS_PAGE_SIZE >= result.total) {
      return { status: "not_found" };
    }
  }
}
