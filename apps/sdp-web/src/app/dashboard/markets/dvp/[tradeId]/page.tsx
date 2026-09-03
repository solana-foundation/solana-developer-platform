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
