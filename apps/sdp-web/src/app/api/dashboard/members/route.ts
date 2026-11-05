import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.members",
    path: `/v1/members${new URL(request.url).search}`,
  });
}
