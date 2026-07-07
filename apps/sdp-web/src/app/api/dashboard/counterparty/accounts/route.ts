import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.counterparty.accounts.search",
    path: `/v1/counterparties/accounts${new URL(request.url).search}`,
  });
}
