import { proxyToSdpApi } from "@/lib/sdp-api";
export async function GET(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.fireblocks.destination",
    path: `/internal/dashboard/fireblocks/destination${new URL(request.url).search}`,
  });
}
