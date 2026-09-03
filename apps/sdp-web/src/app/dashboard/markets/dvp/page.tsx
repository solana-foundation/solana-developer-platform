import { withDashboardPageTrace } from "@/lib/dashboard-page-trace";
import { fetchDvpTrades } from "./dvp-trades.data";
import { DvpTradesWorkspace } from "./dvp-trades-workspace";

/** Trade state changes on chain, so a cached list would show stale funding. */
export const dynamic = "force-dynamic";

export default async function DvpTradesPage() {
  return withDashboardPageTrace("dashboard.dvp.trades.page", async ({ apiClient }) => {
    const { trades, error } = await fetchDvpTrades(apiClient.request);
    return <DvpTradesWorkspace error={error} trades={trades} />;
  });
}
