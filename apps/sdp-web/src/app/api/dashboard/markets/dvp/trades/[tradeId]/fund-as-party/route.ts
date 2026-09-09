import { proxyToSdpApi } from "@/lib/sdp-api";

/**
 * Funding a leg of a trade another organization created.
 *
 * Separate from `fund` because the API separates them: that route asks whether
 * the caller owns the trade, this one asks whether they hold the key to a party
 * address on it. Like the other, a 202 is a normal outcome — the funder's own
 * wallet policy governs this, so it may be awaiting approval rather than
 * failing.
 */
export async function POST(request: Request, { params }: { params: Promise<{ tradeId: string }> }) {
  const { tradeId } = await params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.dvp.trades.fundAsParty",
    path: `/v1/dvp/trades/${encodeURIComponent(tradeId)}/fund-as-party`,
  });
}
