import { proxyToSdpApi } from "@/lib/sdp-api";

type RouteContext = { params: Promise<{ paymentRequestId: string }> };

/** One payment request, read again while its page watches it for a payment. */
export async function GET(request: Request, context: RouteContext) {
  const { paymentRequestId } = await context.params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.payment-requests.detail",
    path: `/v1/payments/requests/${encodeURIComponent(paymentRequestId)}`,
  });
}
