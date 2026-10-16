import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.wallets",
    path: `/v1/wallets${new URL(request.url).search}`,
  });
}
