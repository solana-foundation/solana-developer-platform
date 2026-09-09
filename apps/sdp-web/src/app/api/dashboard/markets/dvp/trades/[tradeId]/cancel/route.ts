import { proxyToSdpApi } from "@/lib/sdp-api";

/**
 * Closing a trade is subject to wallet policy, so a 202 here is a normal
 * outcome — the operation is awaiting approval, not failing. The proxy passes
 * the upstream status through untouched so the workspace can tell them apart.
 */
export async function POST(request: Request, { params }: { params: Promise<{ tradeId: string }> }) {
  const { tradeId } = await params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.dvp.trades.cancel",
    path: `/v1/dvp/trades/${encodeURIComponent(tradeId)}/cancel`,
  });
}
