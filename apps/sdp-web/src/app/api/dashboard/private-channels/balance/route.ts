import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.private-channels.balance",
    path: `/v1/private-channels/balance${new URL(request.url).search}`,
  });
}
