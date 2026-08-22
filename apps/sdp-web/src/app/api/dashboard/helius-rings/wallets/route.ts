import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.helius-rings.wallets",
    path: "/v1/helius-rings/wallets",
  });
}

export async function POST(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.helius-rings.wallets",
    path: "/v1/helius-rings/wallets",
  });
}
