import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.payments.transactions.list",
    path: `/v1/transactions${new URL(request.url).search}`,
  });
}
