import { proxyToSdpApi } from "@/lib/sdp-api";

export async function POST(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.settings.rpc-test",
    path: "/v1/rpc/test",
  });
}
