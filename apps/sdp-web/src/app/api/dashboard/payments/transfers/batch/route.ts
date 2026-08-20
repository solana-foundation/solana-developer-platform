import { IDEMPOTENCY_KEY_HEADER } from "@/lib/idempotency";
import { proxyToSdpApi } from "@/lib/sdp-api";

export async function POST(request: Request) {
  const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER);

  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.payments.transfers.batch.post",
    path: "/v1/payments/transfer-batches",
    // Do not pass the inbound header bag. This value is the only client-owned
    // transport metadata the endpoint accepts; proxyToSdpApi owns every other
    // upstream header. Without it, every dashboard retry is a NEW batch.
    upstreamHeaders: idempotencyKey ? { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey } : undefined,
  });
}
