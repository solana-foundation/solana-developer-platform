import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.api-keys",
    path: `/v1/api-keys${new URL(request.url).search}`,
  });
}
