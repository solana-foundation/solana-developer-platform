import { proxyToSdpApi } from "@/lib/sdp-api";
export async function POST(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.provider_actions.preparations",
    path: "/v1/earn/provider-actions/preparations",
  });
}
