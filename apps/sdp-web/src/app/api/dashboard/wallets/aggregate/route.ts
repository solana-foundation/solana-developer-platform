import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.wallets.aggregate",
    path: `/v1/wallets/aggregate${new URL(request.url).search}`,
  });
}
