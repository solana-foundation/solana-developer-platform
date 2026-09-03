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

export function DvpTradeDetailClient({ trade }: { trade: DvpTrade }) {
  return <DvpTradeDetailWorkspace cluster={useSolanaCluster()} trade={trade} />;
}
