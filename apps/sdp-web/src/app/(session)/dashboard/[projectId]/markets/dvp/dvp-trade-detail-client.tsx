"use client";

import { DvpTradeDetailSkeleton } from "@/app/(session)/dashboard/[projectId]/markets/markets-route-skeletons";
import ProjectNotFound from "@/app/(session)/dashboard/[projectId]/not-found";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useSolanaCluster } from "@/lib/use-solana-cluster";
import { DvpTradeDetailWorkspace } from "./dvp-trade-detail-workspace";
import { DvpTradeLoadError } from "./dvp-trade-load-error";
import { useDvpTrade } from "./dvp-trades.data";

/**
 * One trade's page. A trade outside the caller's scope answers 404 upstream by design, so an absent
 * trade and an unauthorized one are indistinguishable here, which is the point: neither reveals
 * that the other exists. Every other failure is a failure to find out, never an absence: a DvP
 * trade holds both parties' money in escrow, so "gone" is the worst possible wrong answer.
 */
export function DvpTradeDetailClient({ tradeId }: { tradeId: string }) {
  const { data: trade, error, mutate } = useDvpTrade(tradeId);
  const { canWrite } = useDashboardWorkspace().dashboardAccess.capabilities;
  const cluster = useSolanaCluster();
  if (trade !== undefined) {
    return <DvpTradeDetailWorkspace canWrite={canWrite} cluster={cluster} trade={trade} />;
  }
  if (error === undefined) {
    return <DvpTradeDetailSkeleton />;
  }
  if (error.status === 404) {
    return <ProjectNotFound />;
  }
  return (
    <DvpTradeLoadError
      message={error.message === "" ? null : error.message}
      onRetry={() => void mutate()}
    />
  );
}
