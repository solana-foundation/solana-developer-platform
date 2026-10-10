import { proxyToSdpApi } from "@/lib/sdp-api";

export async function POST(request: Request, { params }: { params: Promise<{ tradeId: string }> }) {
  const { tradeId } = await params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.dvp.trades.settle",
    path: `/v1/dvp/trades/${encodeURIComponent(tradeId)}/settle`,
  });
}
