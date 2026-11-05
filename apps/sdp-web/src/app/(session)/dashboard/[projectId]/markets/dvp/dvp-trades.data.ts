"use client";

import type { DvpSettlementAvailability, DvpTradeSide, DvpTradeStatus } from "@sdp/types/dvp";
import { z } from "zod";
import type { DashboardRequestKey } from "@/lib/dashboard-request-key";
import { readDashboardRequest, useDashboardKeyScope, useDashboardRead } from "@/lib/dashboard-swr";
import { useCadencedDashboardSWR } from "@/lib/use-cadenced-swr";
import { dvpQueryKeys } from "./dvp-query-key";
import { type DvpPartyRef, type DvpTrade, dvpActionWalletSchema } from "./dvp-trade";
import { isDvpTradeTerminal } from "./dvp-trades-query";

// Action metadata is optional on non-action reads, but must be valid when present.
const legActionWalletSchema = z.object({
  party: z.object({ actionWallet: dvpActionWalletSchema.nullish() }).optional(),
});

/**
 * The list filters the API narrows SERVER-SIDE. `statuses` maps the UI's status
 * group to the real statuses behind it; `settlementAvailability` narrows a
 * group that means "can settle now"; `q` is the search text. `null` means
 * unfiltered on that axis, explicit because the house has no default params.
 */
export interface DvpTradesFilters {
  statuses: DvpTradeStatus[] | null;
  settlementAvailability: DvpSettlementAvailability[] | null;
  q: string | null;
}

/** Whether both legs decode far enough for the views to read an action wallet. */
function legsRenderable(legs: unknown): boolean {
  return (
    typeof legs === "object" &&
    legs !== null &&
    legActionWalletSchema.safeParse((legs as DvpTrade["legs"]).a).success &&
    legActionWalletSchema.safeParse((legs as DvpTrade["legs"]).b).success
  );
}

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
    typeof trade.id === "string" && typeof trade.status === "string" && legsRenderable(trade.legs)
  );
}

// A malformed row would throw in the table the same way a malformed trade throws on the detail
// page, taking the whole list down with it. Dropping the row keeps every readable trade visible.
const dvpTradesResponseSchema = z.object({
  data: z.object({
    trades: z.array(z.unknown()).transform((rows) => rows.filter(isRenderableTrade)),
  }),
});

/**
 * The project's trades, narrowed server-side by `filters`: the upstream list is capped with no
 * cursor, so a client-side filter over the newest page would make an older matching trade
 * unfindable. The previous filter's rows stay on screen while the next one loads.
 */
export function useDvpTrades(filters: DvpTradesFilters) {
  const scope = useDashboardKeyScope();
  const response = useDashboardRead(dvpQueryKeys.trades(scope, filters), dvpTradesResponseSchema, {
    keepPreviousData: true,
  });
  return { ...response, data: response.data?.data.trades };
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
    legsRenderable(trade.legs)
  );
}

const dvpInboundTradesResponseSchema = z.object({
  data: z.object({
    trades: z.array(z.unknown()).transform((rows) => rows.filter(isRenderableInbound)),
  }),
});

/** Trades another organization created that name one of this project's wallets. */
export function useDvpInboundTrades() {
  const scope = useDashboardKeyScope();
  const response = useDashboardRead(
    dvpQueryKeys.inboundTrades(scope),
    dvpInboundTradesResponseSchema
  );
  return { ...response, data: response.data?.data.trades };
}

// A 200 carrying `{}` or a trade the views cannot read is a failed read, not an absent trade: the
// trade may sit in escrow holding both parties' money.
const dvpTradeResponseSchema = z.object({
  data: z.object({ trade: z.custom<DvpTrade>(isRenderableTrade) }),
});

/** An open trade changes when the counterparty pays into escrow, which nothing announces. */
const OPEN_TRADE_POLL_MS = 6_000;

function readDvpTrade(key: DashboardRequestKey) {
  return readDashboardRequest(key, dvpTradeResponseSchema);
}

/**
 * One trade, re-read every few seconds while it is loaded and can still change, and on return to
 * the tab, so a counterparty's deposit appears without a reload. A terminal trade, a missing one
 * and a failed read do not poll.
 */
export function useDvpTrade(tradeId: string) {
  const scope = useDashboardKeyScope();
  const response = useCadencedDashboardSWR(
    dvpQueryKeys.trade(scope, { tradeId }),
    readDvpTrade,
    (latest) =>
      latest !== undefined && !isDvpTradeTerminal(latest.data.trade.status)
        ? OPEN_TRADE_POLL_MS
        : 0,
    {}
  );
  return { ...response, data: response.data?.data.trade };
}
