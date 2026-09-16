import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(request: Request, { params }: { params: Promise<{ tradeId: string }> }) {
  const { tradeId } = await params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.dvp.trades.get",
    path: `/v1/dvp/trades/${encodeURIComponent(tradeId)}`,
  });
}
