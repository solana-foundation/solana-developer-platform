import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(request: Request) {
  return proxyToSdpApi(
    request,
    "route.dashboard.counterparty.accounts.search",
    `/v1/counterparties/accounts${new URL(request.url).search}`
  );
}
