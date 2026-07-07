import { proxyToSdpApi } from "@/lib/sdp-api";

export async function POST(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.payments.transfers.batch.estimate.post",
    path: "/v1/payments/transfer-batches/estimate",
  });
}
