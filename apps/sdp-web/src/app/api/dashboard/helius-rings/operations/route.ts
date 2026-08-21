import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.helius-rings.operations",
    path: "/v1/helius-rings/operations",
  });
}

export async function POST(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.helius-rings.operations",
    path: "/v1/helius-rings/operations",
  });
}
