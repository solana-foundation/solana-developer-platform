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
      };
    }

    return { trade: body.data?.trade ?? null, error: null };
  } catch (error) {
    return {
      trade: null,
      error: error instanceof Error ? error.message : "DvP trade request failed.",
    };
  }
}
