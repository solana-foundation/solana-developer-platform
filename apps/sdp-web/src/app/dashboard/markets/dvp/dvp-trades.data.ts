import type { SdpApiClient } from "@/lib/sdp-api";
import type { DvpTrade } from "./dvp-trade";

/**
 * The upstream list is capped at 100 and has no cursor. Asking for a bounded
 * page rather than everything keeps the table honest about being a recent-first
 * view instead of pretending to be a complete ledger.
 */
export const DVP_TRADES_PAGE_SIZE = 50;

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

export async function fetchDvpTrades(request: SdpApiClient["request"]): Promise<DvpTradesResult> {
  try {
    const response = await request(`/v1/dvp/trades?limit=${DVP_TRADES_PAGE_SIZE}`);
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
