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

/** Longest search the Requests list carries in its URL. */
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
 * The most requests the list reads to search, or to settle open requests, before it pages
 * them itself; the API has no search, so a searched list reads this far and no further.
 */
export const PAYMENT_REQUESTS_SCAN_CAP = 500;

type PaymentRequestsScan = PaymentRequestsResult & {
  /** More requests exist than {@link PAYMENT_REQUESTS_SCAN_CAP}. */
  capped: boolean;
};

/**
 * The newest payment requests of every status, up to {@link PAYMENT_REQUESTS_SCAN_CAP}, read
 * in pages of {@link PAYMENT_REQUESTS_PAGE_SIZE}. Listing reconciles each open request it
 * reads, and saves any that has been paid, so the rows carry the status the list shows.
 *
 * The pages are read without a status filter. Under one, a request that settles, expires or is
 * canceled while the pages are read leaves the filtered set, so every later offset moves up a
 * row and a page skips one. Newest first across every status, a row only moves when a request
 * is created: that pushes the rest down, so a page repeats a row (dropped here) and the total
 * grows (read on to cover it).
 */
async function scanPaymentRequests(request: SdpApiClient["request"]): Promise<PaymentRequestsScan> {
  const first = await fetchPaymentRequests(request, { page: 1 });
  if (!first.ok) return { ...first, capped: false };
  const pages = [first];
  let total = first.total;
  for (;;) {
    const needed = Math.ceil(
      Math.min(total, PAYMENT_REQUESTS_SCAN_CAP) / PAYMENT_REQUESTS_PAGE_SIZE
    );
    if (pages.length >= needed) break;
    const read = await Promise.all(
      Array.from({ length: needed - pages.length }, (_, index) =>
        fetchPaymentRequests(request, { page: pages.length + index + 1 })
      )
    );
    const failed = read.find((result) => !result.ok);
    if (failed) return { ...failed, capped: false };
    pages.push(...read);
    total = Math.max(total, ...read.map((result) => result.total));
  }
  // Keyed by id, so a repeated row keeps its first place.
  const byId = new Map(pages.flatMap((result) => result.data).map((row) => [row.id, row]));
  const data = [...byId.values()].slice(0, PAYMENT_REQUESTS_SCAN_CAP);
  return { ok: true, data, total, capped: total > PAYMENT_REQUESTS_SCAN_CAP };
}

/** Every well-known token's symbol by mint, on any cluster, for searching by symbol. */
const TOKEN_SYMBOL_BY_MINT: ReadonlyMap<string, string> = new Map(
  Object.values(WELL_KNOWN_TOKENS).flatMap((token: WellKnownToken) =>
    Object.values(token.mints).flatMap((mint) =>
      mint ? [[mint.address, token.symbol] as const] : []
    )
  )
);

/**
 * Whether a request matches a search: its amount, token, payer's name, destination or
 * reference contains the needle, ignoring case.
 *
 * @param request - The request.
 * @param needle - The search, already trimmed.
 * @param counterpartyNames - Contact display names by id.
 * @returns `true` when any of those fields contains the needle.
 */
export function paymentRequestMatchesSearch(
  request: PaymentRequest,
  needle: string,
  counterpartyNames: ReadonlyMap<string, string>
): boolean {
  return [
    request.amount,
    TOKEN_SYMBOL_BY_MINT.get(request.token) ?? request.token,
    request.counterpartyId ? (counterpartyNames.get(request.counterpartyId) ?? "") : "",
    request.destinationAddress,
    request.reference,
  ]
    .join(" ")
    .toLowerCase()
    .includes(needle.toLowerCase());
}

export type PaymentRequestsListResult = PaymentRequestsResult & {
  /** The search read only the newest {@link PAYMENT_REQUESTS_SCAN_CAP} requests. */
  searchCapped: boolean;
};

function listFailure({ error, localErrorCode }: PaymentRequestsResult): PaymentRequestsListResult {
  return {
    ok: false,
    data: [],
    total: 0,
    error,
    ...(localErrorCode ? { localErrorCode } : {}),
    searchCapped: false,
  };
}

function pageOf(
  rows: readonly PaymentRequest[],
  state: PaymentRequestsListState,
  searchCapped: boolean
): PaymentRequestsListResult {
  const start = (state.page - 1) * state.pageSize;
  return {
    ok: true,
    data: rows.slice(start, start + state.pageSize),
    total: rows.length,
    searchCapped,
  };
}

/**
 * One page of the Requests list as its URL names it. With no search and no status, or a status
 * no payment can change (canceled, expired), the API pages it. Awaiting payment and paid are
 * matched here after reading every request, since listing settles any open one that has been
 * paid, and the API's filter reads the stored status: a request paid since the last read would
 * otherwise be missed by Paid and shown as paid under Awaiting payment. The API has no search,
 * so a search matches here too. Both read up to {@link PAYMENT_REQUESTS_SCAN_CAP} requests;
 * past it, a status filter with no search goes back to the API's pages, the newest requests
 * already settled.
 *
 * @param request - Authenticated SDP API fetcher.
 * @param state - The list's page, size, status and search.
 * @param options.counterpartyNames - Contact names by id, read only when the list is searched.
 * @returns The page's rows, how many requests match in all, and whether a search stopped at the
 *   cap; on any failure `{ ok: false, data: [], total: 0, error }`. Never throws.
 */
export async function loadPaymentRequestsList(
  request: SdpApiClient["request"],
  state: PaymentRequestsListState,
  options: { counterpartyNames?: () => Promise<ReadonlyMap<string, string>> } = {}
): Promise<PaymentRequestsListResult> {
  const { status, search } = state;
  const pageFromApi = async (): Promise<PaymentRequestsListResult> => ({
    ...(await fetchPaymentRequests(request, {
      page: state.page,
      pageSize: state.pageSize,
      ...(status ? { status } : {}),
    })),
    searchCapped: false,
  });
  if (search === null && status !== "awaiting_payment" && status !== "paid") {
    return pageFromApi();
  }
  const scan = await scanPaymentRequests(request);
  if (!scan.ok) return listFailure(scan);
  if (search === null && scan.capped) return pageFromApi();
  const counterpartyNames =
    search !== null && options.counterpartyNames ? await options.counterpartyNames() : new Map();
  const rows = scan.data.filter(
    (row) =>
      (status === null || row.status === status) &&
      (search === null || paymentRequestMatchesSearch(row, search, counterpartyNames))
  );
  return pageOf(rows, state, search !== null && scan.capped);
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
