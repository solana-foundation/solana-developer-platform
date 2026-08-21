import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.helius-rings.health",
    path: "/v1/helius-rings/health",
  });
}
