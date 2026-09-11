import { withDashboardPageTrace } from "@/lib/dashboard-page-trace";
import { fetchDvpInboundTrades, fetchDvpTrades } from "./dvp-trades.data";
import { parseDvpTradesFilters } from "./dvp-trades-query";
import { DvpTradesWorkspace } from "./dvp-trades-workspace";

/** Trade state changes on chain, so a cached list would show stale funding. */
export const dynamic = "force-dynamic";

interface DvpTradesPageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export default async function DvpTradesPage({ searchParams }: DvpTradesPageProps) {
  return withDashboardPageTrace("dashboard.dvp.trades.page", async ({ apiClient }) => {
    // The filters live in the URL (the transactions-page pattern): the server
    // refetches on every navigation with the group mapped to the real statuses
    // behind it, because the list is capped and a client-side filter would make
    // an older matching trade unfindable. `waiting` never rides the URL — it
    // selects the inbound segment, which is client state — so it reads as all.
    const { status, filters } = parseDvpTradesFilters((await searchParams) ?? {});
    const statusFilter = status === "waiting" ? "all" : status;
    // In parallel: the inbound panel is additional information about the same
    // page, so making the list wait on it would slow the thing everyone came
    // for to serve the thing only some projects ever have.
    const [{ trades, error }, inbound] = await Promise.all([
      fetchDvpTrades(apiClient.request, filters),
      fetchDvpInboundTrades(apiClient.request),
    ]);
    return (
      <DvpTradesWorkspace
        error={error}
        searchQuery={filters.q === null ? "" : filters.q}
        inbound={inbound}
        statusFilter={statusFilter}
        trades={trades}
      />
    );
  });
}
