import { proxyToSdpApi } from "@/lib/sdp-api";

type RouteContext = { params: Promise<{ paymentRequestId: string }> };

/**
 * Cancel a payment request. The API answers it only to a member whose role holds
 * `payment_requests.manage`; the dashboard's Idempotency-Key is forwarded with it.
 *
 * @param request - The dashboard's request.
 * @param context - The route's params: the payment request id.
 * @returns The API's answer.
 */
export async function POST(request: Request, context: RouteContext) {
  const { paymentRequestId } = await context.params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.payment-requests.cancel",
    path: `/v1/payments/requests/${encodeURIComponent(paymentRequestId)}/cancel`,
  });
}
