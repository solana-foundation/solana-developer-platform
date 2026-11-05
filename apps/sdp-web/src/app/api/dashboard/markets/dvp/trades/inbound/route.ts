import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.dvp.trades.inbound",
    path: "/v1/dvp/trades/inbound",
  });
}
