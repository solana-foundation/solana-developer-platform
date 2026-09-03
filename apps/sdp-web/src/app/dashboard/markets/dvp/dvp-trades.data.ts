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

    return { trades: body.data?.trades ?? [], error: null };
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

    return { trade: body.data?.trade ?? null, error: null, status: response.status };
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
