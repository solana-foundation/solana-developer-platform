import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(request: Request) {
  const url = new URL(request.url);
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.payments.transfer-batches.list",
    path: `/v1/payments/transfer-batches${url.search}`,
  });
}
