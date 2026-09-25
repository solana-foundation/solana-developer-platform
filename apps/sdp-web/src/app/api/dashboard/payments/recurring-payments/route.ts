import { forwardedIdempotencyHeaders } from "@/lib/idempotency";
import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.recurring-payments.list",
    path: `/v1/payments/recurring-payments${new URL(request.url).search}`,
  });
}

export async function POST(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.recurring-payments.create",
    path: "/v1/payments/recurring-payments",
    // Forward only the caller's Idempotency-Key: it is the one client-owned
    // transport metadata the endpoint accepts, and without it a retried create
    // would mint a second recurring payment (a duplicate future debit).
    upstreamHeaders: forwardedIdempotencyHeaders(request),
  });
}
