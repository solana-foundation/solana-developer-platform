import {
  type ListPaymentRequestsResponse,
  PAYMENT_REQUEST_STATUSES,
  type PaymentRequest,
  type PaymentRequestLink,
  paymentRequestSchema,
} from "@sdp/types/payments";
import {
  type SolanaCluster,
  WELL_KNOWN_TOKENS,
  type WellKnownToken,
} from "@sdp/types/well-known-tokens";
import { z } from "zod";
import { dashboardFetch } from "@/lib/dashboard-fetch";
import { type DashboardRequestKey, dashboardRequestKey } from "@/lib/dashboard-request-key";
import { readDashboardRequest } from "@/lib/dashboard-swr";
import { PAYMENT_REQUESTS_HREF } from "@/lib/payments-routes";

export const PAYMENT_REQUESTS_PAGE_SIZE = 100;

/** The detail read's envelope, parsed at the API boundary. */
export const paymentRequestDetailResponseSchema = z.object({ data: paymentRequestSchema });

export const paymentRequestsListResponseSchema = z.object({
  data: z.object({
    paymentRequests: z.array(paymentRequestSchema),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
  }),
});

/** The link read's envelope, parsed: its token is a bearer credential (APE-849). */
export const paymentRequestLinkResponseSchema = z.object({
  data: z.object({
    id: z.string(),
    publicToken: z.string().min(1),
  }) satisfies z.ZodType<PaymentRequestLink>,
});

export interface PaymentRequestTokenOption {
  mintAddress: string;
  symbol: string;
}

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

/** Rows a page of the Requests list shows until the user picks another size. */
export const PAYMENT_REQUESTS_LIST_DEFAULT_PAGE_SIZE = 25;

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

/** Every well-known token's symbol by mint, on any cluster, for searching by symbol. */
const TOKEN_SYMBOL_BY_MINT: ReadonlyMap<string, string> = new Map(
  Object.values(WELL_KNOWN_TOKENS).flatMap((token: WellKnownToken) =>
    Object.values(token.mints).flatMap((mint) =>
      mint ? [[mint.address, token.symbol] as const] : []
    )
  )
);

/**
 * Whether a request matches a search: its amount, token, destination or reference contains the
 * needle, ignoring case.
 *
 * @param request - The request.
 * @param needle - The search, already trimmed.
 * @returns `true` when any of those fields contains the needle.
 */
export function paymentRequestMatchesSearch(request: PaymentRequest, needle: string): boolean {
  return [
    request.amount,
    TOKEN_SYMBOL_BY_MINT.get(request.token) ?? request.token,
    request.destinationAddress,
    request.reference,
  ]
    .join(" ")
    .toLowerCase()
    .includes(needle.toLowerCase());
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

export interface PaymentRequestsListView {
  rows: PaymentRequest[];
  /** How many requests the API counts under the status filter. */
  total: number;
  /**
   * Whether `total` is exactly how many requests the status filter matches. Under Awaiting
   * payment it is the API's count by stored status, an upper bound the list does not show.
   */
  totalIsExact: boolean;
  /** Whether the API has a page after this one. */
  hasNextPage: boolean;
}

/**
 * One page of the Requests list as the API returned it for the list's page, size and status.
 * Under Awaiting payment, the rows the API returns as paid are left out (see below).
 */
export function paymentRequestsListView(
  page: ListPaymentRequestsResponse,
  state: PaymentRequestsListState
): PaymentRequestsListView {
  const hasNextPage = state.page * state.pageSize < page.total;
  if (state.status !== "awaiting_payment") {
    return { rows: page.paymentRequests, total: page.total, totalIsExact: true, hasNextPage };
  }
  // The API filters by the stored status, and listing then reconciles each open request on chain:
  // one paid since it was last read comes back paid (and is saved so). Awaiting payment leaves
  // those rows out, so no row shows the wrong status. Only this page is reconciled, so the API's
  // total still counts requests paid on other, unread pages: it is an upper bound, which the
  // list uses for its pages but does not show as a count (`totalIsExact: false`).
  // TODO(api): filter and count by the reconciled status, so Awaiting payment can show its count
  // again and Paid stops missing a request paid since its last read until something reads it
  // again. Known limitation of the API, not of this list.
  return {
    rows: page.paymentRequests.filter((row) => row.status === "awaiting_payment"),
    total: page.total,
    totalIsExact: false,
    hasNextPage,
  };
}

/**
 * Cancel a payment request from the browser, through the dashboard's proxy, which sends it under
 * the action's Idempotency-Key. The page reads the request again afterwards, so the answer's
 * body is not kept.
 *
 * @param requestId - The request's id.
 * @returns Whether the API canceled it, with its error message when not; never throws.
 */
export async function cancelPaymentRequest(
  requestId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await dashboardFetch(
    `/api/dashboard/payments/requests/${encodeURIComponent(requestId)}/cancel`,
    { method: "POST", body: {} }
  );
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/** Who canceled a request, by the name the dashboard shows; `name` is null when it cannot be read. */
export type PaymentRequestCanceler =
  | { kind: "api_key"; id: string; name: string | null }
  | { kind: "member"; id: string; name: string | null };

// The members read is this page's own entry (its params differ from the members page's), so
// only the fields it names are kept.
const memberDirectoryPageSchema = z.object({
  data: z.object({
    members: z.array(
      z.object({
        user: z.object({ id: z.string(), email: z.string(), name: z.string().nullable() }),
      })
    ),
    meta: z.object({ hasMore: z.boolean() }),
  }),
});

export function memberDisplayName(user: { email: string; name: string | null }): string | null {
  const name = user.name?.trim();
  if (name) return name;
  const email = user.email.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

/**
 * The organization's members up to the key's `cap`, one page at a time, for naming who canceled
 * a request. `cap` is not sent; it bounds how many pages are read.
 */
export async function readMemberDirectory(
  key: DashboardRequestKey
): Promise<{ id: string; email: string; name: string | null }[]> {
  const { cap, ...params } = key[3] ?? {};
  const scope = { projectId: key[0], mode: key[1] };
  const members: { id: string; email: string; name: string | null }[] = [];
  for (let page = 1; members.length < Number(cap); page += 1) {
    const body = await readDashboardRequest(
      dashboardRequestKey(scope, key[2], { ...params, page }),
      memberDirectoryPageSchema
    );
    members.push(...body.data.members.map((member) => member.user));
    if (!body.data.meta.hasMore) break;
  }
  return members;
}
