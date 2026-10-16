"use client";

/**
 * Client boundary for the trade detail view: owns the live watch, keeps the
 * workspace a pure function of its props.
 */

import { useSolanaCluster } from "@/lib/use-solana-cluster";
import type { DvpTrade } from "./dvp-trade";
import { DvpTradeDetailWorkspace } from "./dvp-trade-detail-workspace";
import { useDvpTradeWatch } from "./use-dvp-trade-watch";

export function DvpTradeDetailClient({ trade }: { trade: DvpTrade }) {
  // The counterparty's deposit is the one event nothing announces, so an open
  // trade watches for it here rather than waiting to be reloaded by hand.
  useDvpTradeWatch(trade);
  return <DvpTradeDetailWorkspace cluster={useSolanaCluster()} trade={trade} />;
}
