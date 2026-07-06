import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.counterparty.list",
    path: `/v1/counterparties${new URL(request.url).search}`,
  });
}

export async function POST(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.counterparty.create",
    path: "/v1/counterparties",
  });
}
