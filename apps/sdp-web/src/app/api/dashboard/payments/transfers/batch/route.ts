import { proxyToSdpApi } from "@/lib/sdp-api";

export async function POST(request: Request) {
  return proxyToSdpApi(
    request,
    "route.dashboard.payments.transfers.batch.post",
    "/v1/payments/transfer-batches"
  );
}
