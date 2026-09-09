import { proxyToSdpApi } from "@/lib/sdp-api";

/**
 * Funding is subject to wallet policy, so a 202 here is a normal outcome — the
 * operation is awaiting approval, not failing.
 */
export async function POST(request: Request, { params }: { params: Promise<{ tradeId: string }> }) {
  const { tradeId } = await params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.dvp.trades.fund",
    path: `/v1/dvp/trades/${encodeURIComponent(tradeId)}/fund`,
  });
}
