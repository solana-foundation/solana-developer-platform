import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.private-channels.events",
    path: `/v1/private-channels/events${new URL(request.url).search}`,
  });
}
