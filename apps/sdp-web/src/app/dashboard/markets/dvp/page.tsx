import { withDashboardPageTrace } from "@/lib/dashboard-page-trace";
import { fetchDvpInboundTrades, fetchDvpTrades } from "./dvp-trades.data";
import { DvpTradesWorkspace } from "./dvp-trades-workspace";

/** Trade state changes on chain, so a cached list would show stale funding. */
export const dynamic = "force-dynamic";

export default async function DvpTradesPage() {
  return withDashboardPageTrace("dashboard.dvp.trades.page", async ({ apiClient }) => {
    // In parallel: the inbound panel is additional information about the same
    // page, so making the list wait on it would slow the thing everyone came
    // for to serve the thing only some projects ever have.
    const [{ trades, error }, inbound] = await Promise.all([
      fetchDvpTrades(apiClient.request),
      fetchDvpInboundTrades(apiClient.request),
    ]);
    return <DvpTradesWorkspace error={error} inbound={inbound} trades={trades} />;
  });
}
