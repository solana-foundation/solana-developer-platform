import { proxyToSdpApi } from "@/lib/sdp-api";

export async function POST(request: Request, { params }: { params: Promise<{ tradeId: string }> }) {
  const { tradeId } = await params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.dvp.trades.cancel",
    path: `/v1/dvp/trades/${encodeURIComponent(tradeId)}/cancel`,
  });
}
