import { notFound } from "next/navigation";
import { withDashboardPageTrace } from "@/lib/dashboard-page-trace";
import { DvpTradeDetailWorkspace } from "../dvp-trade-detail-workspace";
import { DvpTradeLoadError } from "../dvp-trade-load-error";
import { fetchDvpTrade, isNotFound } from "../dvp-trades.data";

export const dynamic = "force-dynamic";

export default async function DvpTradeDetailPage({
  params,
}: {
  params: Promise<{ tradeId: string }>;
}) {
  const { tradeId } = await params;
  return withDashboardPageTrace("dashboard.dvp.trade.page", async ({ apiClient }) => {
    const result = await fetchDvpTrade(apiClient.request, tradeId);
    const { trade, error } = result;

    if (trade) {
      return <DvpTradeDetailWorkspace trade={trade} />;
    }

    // A missing trade and an unreachable API both arrive here as a null trade,
    // and they need different answers. Rendering a rate limit or a 500 as "not
    // found" tells someone their trade is gone when it is sitting there — so
    // only a genuine 404 becomes one, and everything else says what happened
    // and can be retried.
    if (error && !isNotFound(result)) {
      return <DvpTradeLoadError message={error} />;
    }

    // A trade outside the caller's scope answers 404 upstream by design, so an
    // absent trade and an unauthorized one are indistinguishable here — which is
    // the point: neither should reveal that the other exists.
    notFound();
  });
}
