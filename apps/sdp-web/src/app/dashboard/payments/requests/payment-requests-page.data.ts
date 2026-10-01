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

/** One page of a scan, by its 1-based number. */
interface ScannedPage {
  page: number;
  result: PaymentRequestsResult;
}

/**
 * The newest payment requests, up to {@link PAYMENT_REQUESTS_SCAN_CAP}, read in pages of
 * {@link PAYMENT_REQUESTS_PAGE_SIZE}. Listing reconciles each open request it reads, and saves
 * any that has been paid, so the rows carry the status the list shows.
 *
 * The API pages by offset, so a request that joins or leaves the set read moves every row after
 * it, and the order the pages are read in decides whether that repeats a row (dropped here) or
 * skips one:
 * - With no stored status, a row only moves when a request is created, which pushes the rest
 *   down; the pages are read at once, and the total growing is read on to cover it.
 * - Awaiting payment loses requests as they settle (reading a page settles its paid ones) or
 *   expire, which pulls the rest up. Its pages are read one at a time from the last to the first,
 *   so a request leaving only moves rows already read onto a page still to be read, a repeat at
 *   worst. Even the first page waits, since its own settles would pull the second's newest onto
 *   it: a probe of one row reads the total.
 * - Paid, canceled and expired only gain requests (an open one settles or expires), which pushes
 *   the rest down, so their pages are read one at a time from the first.
 *
 * Reading one page at a time is slower; only a stored status is read so, and only to reach past
 * the unfiltered read's cap (see {@link loadPaymentRequestsList}). A request created while
 * Awaiting payment is read still pushes a row onto a page already read, so it can skip one, as a
 * creation between pages read at once can with no stored status; only cursor paging from the API
 * closes that.
 */
async function scanPaymentRequests(
  request: SdpApiClient["request"],
  storedStatus?: PaymentRequest["status"]
): Promise<PaymentRequestsScan> {
  const readPage = async (page: number, pageSize?: number): Promise<ScannedPage> => ({
    page,
    result: await fetchPaymentRequests(request, {
      page,
      ...(pageSize ? { pageSize } : {}),
      ...(storedStatus ? { status: storedStatus } : {}),
    }),
  });
  const lastFirst = storedStatus === "awaiting_payment";
  const first = await readPage(1, lastFirst ? 1 : undefined);
  if (!first.result.ok) return { ...first.result, capped: false };
  // In the order they were read, so a repeated row's last copy is its freshest.
  const pages: ScannedPage[] = lastFirst ? [] : [first];
  let pagesRead = pages.length;
  let total = first.result.total;
  for (;;) {
    const needed = Math.ceil(
      Math.min(total, PAYMENT_REQUESTS_SCAN_CAP) / PAYMENT_REQUESTS_PAGE_SIZE
    );
    if (pagesRead >= needed) break;
    const unread = Array.from({ length: needed - pagesRead }, (_, index) => pagesRead + index + 1);
    const read: ScannedPage[] = [];
    if (storedStatus === undefined) {
      read.push(...(await Promise.all(unread.map((page) => readPage(page)))));
    } else {
      for (const page of lastFirst ? unread.reverse() : unread) {
        const scanned = await readPage(page);
        read.push(scanned);
        if (!scanned.result.ok) break;
      }
    }
    const failed = read.find((scanned) => !scanned.result.ok);
    if (failed) return { ...failed.result, capped: false };
    pages.push(...read);
    pagesRead = needed;
    total = Math.max(total, ...read.map((scanned) => scanned.result.total));
  }
  const freshest = new Map(
    pages.flatMap((scanned) => scanned.result.data).map((row) => [row.id, row])
  );
  // Once each, in page order: a repeated row keeps its first place.
  const inPageOrder = new Set(
    [...pages]
      .sort((a, b) => a.page - b.page)
      .flatMap((scanned) => scanned.result.data.map((row) => row.id))
  );
  const data = [...inPageOrder].flatMap((id) => {
    const row = freshest.get(id);
    return row ? [row] : [];
  });
  return {
    ok: true,
    data: data.slice(0, PAYMENT_REQUESTS_SCAN_CAP),
    total,
    capped: total > PAYMENT_REQUESTS_SCAN_CAP,
  };
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
 * already settled. A search under a status past it also reads that status's newest requests
 * (Paid reads the open ones too, settling any that has been paid), so a request older than the
 * unfiltered read is still found.
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
  const read = status !== null && scan.capped ? await readPastScan(request, scan, status) : scan;
  if (!read.ok) return listFailure(read);
  const counterpartyNames =
    search !== null && options.counterpartyNames ? await options.counterpartyNames() : new Map();
  const rows = read.data.filter(
    (row) =>
      (status === null || row.status === status) &&
      (search === null || paymentRequestMatchesSearch(row, search, counterpartyNames))
  );
  return pageOf(rows, state, search !== null && read.capped);
}

/** Newest first by creation, keeping the order of requests created at the same time. */
function byNewest(a: PaymentRequest, b: PaymentRequest): number {
  return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
}

/**
 * The capped unfiltered read, followed by the older requests that may show `status`, read by
 * stored status up to {@link PAYMENT_REQUESTS_SCAN_CAP} each. A request shows Paid once
 * listing settles it, so Paid also reads the open requests: any of them that has been paid
 * comes back paid.
 *
 * @returns Every request read, once each, newest first; `capped` when a status read was.
 */
async function readPastScan(
  request: SdpApiClient["request"],
  scan: PaymentRequestsScan,
  status: PaymentRequest["status"]
): Promise<PaymentRequestsScan> {
  const storedStatuses: PaymentRequest["status"][] =
    status === "paid" ? ["awaiting_payment", "paid"] : [status];
  const reads = await Promise.all(
    storedStatuses.map((storedStatus) => scanPaymentRequests(request, storedStatus))
  );
  const failed = reads.find((read) => !read.ok);
  if (failed) return failed;
  const seen = new Set(scan.data.map((row) => row.id));
  const older = new Map(
    reads
      .flatMap((read) => read.data)
      .filter((row) => !seen.has(row.id))
      .map((row) => [row.id, row])
  );
  return {
    ok: true,
    data: [...scan.data, ...[...older.values()].sort(byNewest)],
    total: scan.total,
    capped: reads.some((read) => read.capped),
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
