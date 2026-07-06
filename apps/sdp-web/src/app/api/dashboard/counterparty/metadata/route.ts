import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(request: Request) {
  return proxyToSdpApi(
    request,
    "route.dashboard.counterparty.metadata",
    "/v1/counterparties/metadata"
  );
}
