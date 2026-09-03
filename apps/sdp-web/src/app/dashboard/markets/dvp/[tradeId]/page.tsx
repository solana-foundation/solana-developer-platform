import { notFound } from "next/navigation";
import { withDashboardPageTrace } from "@/lib/dashboard-page-trace";
import { DvpTradeDetailWorkspace } from "../dvp-trade-detail-workspace";
import { fetchDvpTrade } from "../dvp-trades.data";

export const dynamic = "force-dynamic";

export default async function DvpTradeDetailPage({
  params,
}: {
  params: Promise<{ tradeId: string }>;
}) {
  const { tradeId } = await params;
  return withDashboardPageTrace("dashboard.dvp.trade.page", async ({ apiClient }) => {
    const { trade } = await fetchDvpTrade(apiClient.request, tradeId);
    // A trade outside the caller's scope answers 404 upstream by design, so an
    // absent trade and an unauthorized one are indistinguishable here — which is
    // the point: neither should reveal that the other exists.
    if (!trade) {
      notFound();
    }
    return <DvpTradeDetailWorkspace trade={trade} />;
  });
}
