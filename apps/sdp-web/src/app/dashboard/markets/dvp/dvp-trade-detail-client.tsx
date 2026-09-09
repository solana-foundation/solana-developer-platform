"use client";

/**
 * Supplies the active project's cluster to the trade detail view.
 *
 * Split out for the same reason as `create/dvp-create-client.tsx`: the cluster
 * comes from workspace context, and reading it inside the workspace itself
 * would make every test of that view need a provider around it to render at
 * all. The view stays a pure function of its props; this is the only piece that
 * knows where the cluster comes from.
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
