import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.helius-rings.setup-status",
    path: "/v1/helius-rings/setup-status",
  });
}
