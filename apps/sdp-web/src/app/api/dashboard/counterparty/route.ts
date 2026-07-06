import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(request: Request) {
  return proxyToSdpApi(
    request,
    "route.dashboard.counterparty.list",
    `/v1/counterparties${new URL(request.url).search}`
  );
}

export async function POST(request: Request) {
  return proxyToSdpApi(request, "route.dashboard.counterparty.create", "/v1/counterparties");
}
