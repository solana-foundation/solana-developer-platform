import { proxyToSdpApi } from "@/lib/sdp-api";
export async function POST(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.fireblocks.whitelist",
    path: "/internal/dashboard/fireblocks/whitelist",
  });
}
