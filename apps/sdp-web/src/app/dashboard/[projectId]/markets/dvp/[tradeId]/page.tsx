import { notFound } from "next/navigation";
import { DvpTradeDetailClient } from "@/app/dashboard/[projectId]/markets/dvp/dvp-trade-detail-client";
import { DvpTradeLoadError } from "@/app/dashboard/[projectId]/markets/dvp/dvp-trade-load-error";
import { fetchDvpTrade, isNotFound } from "@/app/dashboard/[projectId]/markets/dvp/dvp-trades.data";
import { withDashboardPageTrace } from "@/lib/dashboard-page-trace";

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
      return <DvpTradeDetailClient trade={trade} />;
    }

    // A trade outside the caller's scope answers 404 upstream by design, so an
    // absent trade and an unauthorized one are indistinguishable here, which is
    // the point: neither should reveal that the other exists.
    if (isNotFound(result)) {
      notFound();
    }

    // Everything else is a failure to find out, not an absence. Rendering a
    // rate limit, a 500, or a 200 whose body had no trade in it as "not found"
    // tells someone their trade is gone while it sits in escrow holding both
    // parties' money.
    //
    // Tested by exclusion rather than by listing statuses: a malformed 200
    // carries no error message at all, and an earlier version of this fell
    // through to notFound() precisely because it keyed off the message.
    return <DvpTradeLoadError message={error} />;
  });
}
