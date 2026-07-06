import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.counterparty.metadata",
    path: "/v1/counterparties/metadata",
  });
}
