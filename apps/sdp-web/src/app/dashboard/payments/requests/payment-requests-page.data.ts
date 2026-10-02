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
  return {
    page: parseListInteger(firstParamValue(params.page), 1),
    pageSize: Math.min(
      parseListInteger(firstParamValue(params.pageSize), PAYMENT_REQUESTS_LIST_DEFAULT_PAGE_SIZE),
      PAYMENT_REQUESTS_PAGE_SIZE
    ),
    status: PAYMENT_REQUEST_STATUSES.find((candidate) => candidate === status) ?? null,
    // TODO(api): read `search` again once GET /v1/payments/requests can search. The API has no
    // search parameter, and searching only the requests the dashboard has read would miss older
    // ones, so search is off for now and a `search` in the URL is ignored. Known limitation of the
    // API, not of this list.
    search: null,
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
 * page, its size and its status filter. Under Awaiting payment, the rows the API returns as paid
 * are left out (see below).
 *
 * @param request - Authenticated SDP API fetcher.
 * @param state - The list's page, size and status. Its search is not read, since the API has
 *   none (see {@link parsePaymentRequestsListParams}).
 * @returns The page's rows and how many requests match in all; on any failure
 *   `{ ok: false, data: [], total: 0, error }`. Never throws.
 */
export async function loadPaymentRequestsList(
  request: SdpApiClient["request"],
  state: PaymentRequestsListState
): Promise<PaymentRequestsResult> {
  const { page, pageSize, status } = state;
  const result = await fetchPaymentRequests(request, {
    page,
    pageSize,
    ...(status ? { status } : {}),
  });
  if (!result.ok || status !== "awaiting_payment") return result;
  // The API filters by the stored status, and listing then reconciles each open request on chain:
  // one paid since it was last read comes back paid (and is saved so). Awaiting payment leaves
  // those rows out and lowers the total by as many, so the count and the pages don't claim them.
  // Only this page is reconciled, so requests paid on other, unread pages still count: the total
  // can run high by as many (usually none), and the last page can come up short, until those
  // pages are read and their paid requests saved. No row shows the wrong status.
  // TODO(api): filter and count by the reconciled status. Until then the Awaiting total can run
  // high as above, and Paid misses a request paid since its last read until something reads it
  // again. Known limitation of the API, not of this list.
  const open = result.data.filter((row) => row.status === "awaiting_payment");
  return {
    ...result,
    data: open,
    total: Math.max(0, result.total - (result.data.length - open.length)),
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
  // TODO(api): read the request by id once the API has GET /v1/payments/requests/{id}. Until then
  // this pages through the list, so an older request costs one read per 100 newer ones. Known
  // limitation of the API, not of this page.
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
