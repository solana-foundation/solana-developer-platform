import { proxyToSdpApi } from "@/lib/sdp-api";

const path = "/internal/dashboard/helius-rings/connections";

export async function GET(request: Request) {
  return proxyToSdpApi({ request, traceSource: "route.dashboard.helius-rings.connections", path });
}

export async function POST(request: Request) {
  return proxyToSdpApi({ request, traceSource: "route.dashboard.helius-rings.connections", path });
}
