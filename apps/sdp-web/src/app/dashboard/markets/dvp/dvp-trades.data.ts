import type { DvpTradeSide, DvpTradeStatus } from "@sdp/types";
import type { SdpApiClient } from "@/lib/sdp-api";
import type { DvpPartyRef, DvpTrade } from "./dvp-trade";

/**
 * The upstream list is capped at 100 and has no cursor. Asking for a bounded
 * page rather than everything keeps the table honest about being a recent-first
 * view instead of pretending to be a complete ledger.
 */
export const DVP_TRADES_PAGE_SIZE = 50;

/**
 * The list filters the API narrows SERVER-SIDE. `statuses` maps the UI's status
 * group to the real statuses behind it; `q` is the search text. `null` means
 * unfiltered on that axis, explicit because the house has no default params.
 */
export interface DvpTradesFilters {
  statuses: DvpTradeStatus[] | null;
  q: string | null;
}

/** The explicit no-filter filters: unfiltered is a choice, never a default. */
export const UNFILTERED_DVP_TRADES: DvpTradesFilters = { statuses: null, q: null };

export interface DvpTradesResult {
  trades: DvpTrade[];
  error: string | null;
}

/** Never throws: a list page that renders an error beats one that 500s. */
/**
 * Whether a decoded body is a trade this UI can actually render.
 *
 * `data.trade` was trusted for being present. A 200 carrying `{}` is truthy, so
 * it sailed past the null check and into a view that dereferences `trade.legs.a`
 * — turning a malformed response into a render exception and a server error
 * page, which is the one outcome the surrounding code exists to prevent. The
 * page's own comment says a 200 with no usable trade in it must reach the
 * retryable load error; this is what makes "no usable trade" mean something.
 *
 * Checks the fields the views actually reach for, not the whole schema. A
 * stricter check would reject responses that render perfectly well the day a
 * new optional field appears.
 */
function isRenderableTrade(value: unknown): value is DvpTrade {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const trade = value as Partial<DvpTrade>;
  return (
    typeof trade.id === "string" &&
    typeof trade.status === "string" &&
    typeof trade.legs === "object" &&
    trade.legs !== null &&
    typeof trade.legs.a === "object" &&
    trade.legs.a !== null &&
    typeof trade.legs.b === "object" &&
    trade.legs.b !== null
  );
}

/**
 * Reads the project's trades, narrowed server-side by the given filters.
 *
 * The filters ride the query string because the upstream list is capped with
 * no cursor: a client-side filter over the newest page makes a matching trade
 * older than the page unfindable.
 *
 * @param request - The dashboard API client's request function.
 * @param filters - Status and search narrowing; null on an axis means unfiltered.
 * @returns The trades plus an error message, never a throw.
 */
export async function fetchDvpTrades(
  request: SdpApiClient["request"],
  filters: DvpTradesFilters
): Promise<DvpTradesResult> {
  try {
    const query = new URLSearchParams({ limit: String(DVP_TRADES_PAGE_SIZE) });
    // An EMPTY group must serialize to the absence of the param: the API
    // rejects an empty `status=`, and the `waiting` URL filter (which carries
    // no statuses of its own) parses to one.
    if (filters.statuses !== null && filters.statuses.length > 0) {
      query.set("status", filters.statuses.join(","));
    }
    if (filters.q !== null) {
      query.set("q", filters.q);
    }
    const response = await request(`/v1/dvp/trades?${query.toString()}`);
    const body = (await response.json().catch(() => ({}))) as {
      data?: { trades?: DvpTrade[] };
      error?: { message?: string };
    };

    if (!response.ok) {
      return {
        trades: [],
        error: body.error?.message ?? `DvP trade list request failed (${response.status}).`,
      };
    }

    // A malformed row would throw in the table the same way a malformed trade
    // throws on the detail page, taking the whole list down with it. Dropping
    // the row keeps every readable trade visible.
    return { trades: (body.data?.trades ?? []).filter(isRenderableTrade), error: null };
  } catch (error) {
    return {
      trades: [],
      error: error instanceof Error ? error.message : "DvP trade list request failed.",
    };
  }
}

/**
 * A trade somebody else created that names one of this project's wallets.
 *
 * A deliberately smaller shape than `DvpTrade`. The endpoint withholds
 * everything belonging to the creating organization, so a type carrying those
 * fields as optional would invite a surface to reach for one and render a blank
 * where a reader expects a value.
 */
export interface DvpInboundTrade {
  id: string;
  status: string;
  swapDvp: string;
  /** Which leg is this caller's, per the API's custody lookup. */
  yourSide: DvpTradeSide;
  legs: {
    a: DvpInboundLeg;
    b: DvpInboundLeg;
  };
  expiryTimestamp: string;
  createdAt: string;
}

export interface DvpInboundLeg {
  /**
   * Never attributed on inbound: which registered counterparty a party is
   * belongs to the creating organization, so `counterparty` is always null.
   */
  party: DvpPartyRef;
  mint: string;
  amount: string;
  decimals: number | null;
  symbol: string | null;
  name: string | null;
  escrow: string;
  observedAmount: string | null;
  frozen: boolean;
}

/** Only the fields the panel reads, so a new optional field upstream is not a crash. */
function isRenderableInbound(value: unknown): value is DvpInboundTrade {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const trade = value as Partial<DvpInboundTrade>;
  return (
    typeof trade.id === "string" &&
    (trade.yourSide === "a" || trade.yourSide === "b") &&
    typeof trade.legs === "object" &&
    trade.legs !== null &&
    typeof trade.legs.a === "object" &&
    typeof trade.legs.b === "object"
  );
}

/**
 * Trades waiting on this caller.
 *
 * Never throws and never surfaces its own error: this panel sits above the main
 * list, and a failure to read it must not replace the page a reader came for.
 * An unreadable inbound list renders as no panel, which is what an empty one
 * renders as too — the distinction matters to us and not to them.
 */
export async function fetchDvpInboundTrades(
  request: SdpApiClient["request"]
): Promise<DvpInboundTrade[]> {
  try {
    const response = await request("/v1/dvp/trades/inbound");
    if (!response.ok) {
      return [];
    }
    const body = (await response.json().catch(() => ({}))) as {
      data?: { trades?: unknown[] };
    };
    return (body.data?.trades ?? []).filter(isRenderableInbound);
  } catch {
    return [];
  }
}

export interface DvpTradeResult {
  trade: DvpTrade | null;
  error: string | null;
  /** The upstream status, so a caller can tell "absent" from "unavailable". */
  status: number | null;
}

/**
 * Whether a failed read means the trade is genuinely not there.
 *
 * Only a 404 does. Every other failure — a rate limit, a 500, a dropped
 * connection — means we could not find out, and rendering that as "not found"
 * tells someone their trade is gone when it is sitting there.
 */
export function isNotFound(result: Pick<DvpTradeResult, "status">): boolean {
  return result.status === 404;
}

export async function fetchDvpTrade(
  request: SdpApiClient["request"],
  tradeId: string
): Promise<DvpTradeResult> {
  try {
    const response = await request(`/v1/dvp/trades/${encodeURIComponent(tradeId)}`);
    const body = (await response.json().catch(() => ({}))) as {
      data?: { trade?: DvpTrade };
      error?: { message?: string };
    };

    if (!response.ok) {
      return {
        trade: null,
        error: body.error?.message ?? `DvP trade request failed (${response.status}).`,
        status: response.status,
      };
    }

    const trade = body.data?.trade;
    if (!isRenderableTrade(trade)) {
      return {
        trade: null,
        // No upstream message exists for this — the request succeeded. Saying
        // what happened is better than the empty error a malformed 200 carries.
        error: "The trade came back in a shape this page cannot read.",
        status: response.status,
      };
    }

    return { trade, error: null, status: response.status };
  } catch (error) {
    // A transport failure never reached the API, so there is no status and it
    // must never be read as absence.
    return {
      trade: null,
      error: error instanceof Error ? error.message : "DvP trade request failed.",
      status: null,
    };
  }
}
