import {
  type ListPaymentRequestsResponse,
  type PaginatedResponse,
  type PaymentRequest,
  type SolanaCluster,
  WELL_KNOWN_TOKENS,
  type WellKnownToken,
} from "@sdp/types";
import { PAYMENT_REQUESTS_HREF } from "@/lib/payments-routes";
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
 * @param options - The page (1-based), its size, an optional status and an optional search,
 *   which the API matches against the amount, token, payer, destination, reference and id.
 * @returns `{ ok: true, data, total }` on success; on any failure (non-2xx or
 *   network error) `{ ok: false, data: [], total: 0, error }` — never throws.
 */
export async function fetchPaymentRequests(
  request: SdpApiClient["request"],
  options: {
    page?: number;
    pageSize?: number;
    status?: PaymentRequest["status"];
    search?: string;
  } = {}
): Promise<PaymentRequestsResult> {
  try {
    const query = new URLSearchParams({
      page: String(options.page ?? 1),
      pageSize: String(options.pageSize ?? PAYMENT_REQUESTS_PAGE_SIZE),
      ...(options.status ? { status: options.status } : {}),
      ...(options.search ? { search: options.search } : {}),
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

/** Longest search the Requests list carries in its URL: what the API accepts. */
const PAYMENT_REQUESTS_SEARCH_MAX_LENGTH = 200;

/** The Requests list's page, its size, its status filter and its search, as the URL carries them. */
export interface PaymentRequestsListState {
  page: number;
  pageSize: number;
  status: PaymentRequest["status"] | null;
  /** Trimmed, never empty; `null` when the list is not searched. */
  search: string | null;
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
 * first page, the default size, every status and no search; the size never exceeds what the
 * API serves.
 *
 * @param params - The route's search params.
 * @returns The page, its size, the status filter and the search.
 */
export function parsePaymentRequestsListParams(
  params: Record<string, string | string[] | undefined>
): PaymentRequestsListState {
  const status = firstParamValue(params.status);
  const search = firstParamValue(params.search)
    ?.trim()
    .slice(0, PAYMENT_REQUESTS_SEARCH_MAX_LENGTH);
  return {
    page: parseListInteger(firstParamValue(params.page), 1),
    pageSize: Math.min(
      parseListInteger(firstParamValue(params.pageSize), PAYMENT_REQUESTS_LIST_DEFAULT_PAGE_SIZE),
      PAYMENT_REQUESTS_PAGE_SIZE
    ),
    status: PAYMENT_REQUEST_STATUSES.find((candidate) => candidate === status) ?? null,
    search: search ? search : null,
  };
}

/**
 * The Requests list's URL for a state, leaving out whatever is at its default.
 *
 * @param state - The page, its size, the status filter and the search.
 * @returns A path under {@link PAYMENT_REQUESTS_HREF}.
 */
export function paymentRequestsListHref(state: PaymentRequestsListState): string {
  const query = new URLSearchParams();
  if (state.page > 1) query.set("page", String(state.page));
  if (state.pageSize !== PAYMENT_REQUESTS_LIST_DEFAULT_PAGE_SIZE) {
    query.set("pageSize", String(state.pageSize));
  }
  if (state.status) query.set("status", state.status);
  if (state.search) query.set("search", state.search);
  const search = query.toString();
  return `${PAYMENT_REQUESTS_HREF}${search ? `?${search}` : ""}`;
}

/**
 * One page of the Requests list as its URL names it, read straight from the API's page: its
 * page, its size, its status filter and its search. Before it applies an Awaiting payment or
 * Paid filter the API checks the newest open requests on chain, so a request paid since its
 * last read is counted and listed as paid.
 *
 * @param request - Authenticated SDP API fetcher.
 * @param state - The list's page, size, status and search.
 * @returns The page's rows and how many requests match in all; on any failure
 *   `{ ok: false, data: [], total: 0, error }`. Never throws.
 */
export function loadPaymentRequestsList(
  request: SdpApiClient["request"],
  state: PaymentRequestsListState
): Promise<PaymentRequestsResult> {
  const { page, pageSize, status, search } = state;
  return fetchPaymentRequests(request, {
    page,
    pageSize,
    ...(status ? { status } : {}),
    ...(search ? { search } : {}),
  });
}

export type PaymentRequestDetailResult =
  | { status: "found"; request: PaymentRequest }
  | { status: "not_found" }
  | { status: "error"; error: string | undefined };

/**
 * One payment request by id, from `GET /v1/payments/requests/{requestId}`.
 *
 * @param request - Authenticated SDP API fetcher.
 * @param requestId - The request's id.
 * @returns The request, `not_found` when the API has no request by that id in this project, or
 *   the load error; never throws.
 */
export async function fetchPaymentRequestDetail(
  request: SdpApiClient["request"],
  requestId: string
): Promise<PaymentRequestDetailResult> {
  try {
    const response = await request(`/v1/payments/requests/${encodeURIComponent(requestId)}`);
    if (response.status === 404) return { status: "not_found" };
    if (!response.ok) return { status: "error", error: await response.text() };
    const json = (await response.json()) as { data: PaymentRequest };
    return { status: "found", request: json.data };
  } catch (error) {
    return { status: "error", error: error instanceof Error ? error.message : undefined };
  }
}
